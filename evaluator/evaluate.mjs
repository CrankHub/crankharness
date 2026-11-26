#!/usr/bin/env node
// evaluate: the fresh-context evaluator (ROB-406). Judges a branch against its issue's acceptance criteria.
//
//   node evaluator/evaluate.mjs --repo <path> --issue <KEY> --branch <name>
//                               [--provider claude|codex|grok] [--issue-file <path>] [--base <ref>]
//
// Writes <repo>/.harness/runs/<ISSUE>/evaluation.json:
//   { issue, branch, base, provider, verdict: "PASS"|"NEEDS_WORK",
//     criteria: [{ id, text, met, evidence }], remediation: [..], notes }
// Exit 0 for PASS, 1 for NEEDS_WORK, 2 for an error (no verdict; evaluation.json is not written).
//
// It never changes the repository: it reads the branch through git objects (git diff, git show), not the working
// tree, and runs the worker in a temporary folder outside the repository with read-only tools. The only files it
// writes are in the run folder: evaluation.json, evaluation.prompt.md and evaluation.reply.txt (the previous
// evaluation.json is kept as evaluation.prev.json).
//
// The worker is injectable. CRANKHARNESS_EVALUATOR_CMD, when set, is a shell command that gets the prompt on
// stdin, runs in the evidence folder and prints its reply on stdout; the tests use it with a fake worker so they
// never call a real model. In code, evaluate({ runWorker }) does the same.

import { spawnSync } from 'node:child_process';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parseFrontMatter } from '../check-contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_DIFF = 150_000; // characters of diff in the prompt; the full diff is in the evidence folder
const MAX_TEST_OUTPUT = 40_000;
const MAX_FILE = 200_000; // changed files larger than this are listed, not copied
const MAX_ARTIFACT = 20 * 1024 * 1024;
const ARTIFACT = /\.(png|jpe?g|gif|webp|svg|zip|webm|mp4|har|trace|log)$/i;
const TIMEOUT_MS = Number(process.env.CRANKHARNESS_EVALUATOR_TIMEOUT_MS) || 20 * 60 * 1000;

export class EvaluatorError extends Error {}

// --- the providers: one entry per headless worker ------------------------------------------------------------
//
// Each takes the prompt and the evidence folder and returns the model's reply text. Every one runs with no write
// access: claude with only Read, Glob and Grep; codex in its read-only sandbox. Add a provider here and nowhere
// else. All of them use the machine's subscription login; none reads or needs an API key.

export const PROVIDERS = {
  claude: {
    describe: 'claude -p, tools Read/Glob/Grep only',
    run(prompt, cwd) {
      const r = runCommand('claude', [
        '-p',
        '--output-format', 'json',
        '--tools', 'Read,Glob,Grep',
        '--permission-mode', 'dontAsk',
        '--strict-mcp-config',
        '--no-session-persistence',
      ], { cwd, input: prompt });
      let envelope;
      try {
        envelope = JSON.parse(r.stdout);
      } catch {
        throw new EvaluatorError(`claude -p did not return JSON (exit ${r.status}): ${clip(r.stdout || r.stderr, 500)}`);
      }
      if (envelope.is_error) {
        const why = clip(String(envelope.result), 500);
        const hint = /authenticat|log ?in|oauth/i.test(why)
          ? ' (the claude CLI on this machine is not logged in: run `claude auth login` with the subscription account)'
          : '';
        throw new EvaluatorError(`claude -p failed: ${why}${hint}`);
      }
      return String(envelope.result ?? '');
    },
  },
  codex: {
    describe: 'codex exec, read-only sandbox',
    run(prompt, cwd) {
      // Needs the Codex subscription login (ROB-403). Without it this fails and says so.
      const r = runCommand('codex', [
        'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-o', 'reply.txt', '-',
      ], { cwd, input: prompt, shell: process.platform === 'win32' });
      const out = join(cwd, 'reply.txt');
      if (r.status !== 0 || !existsSync(out)) {
        throw new EvaluatorError(`codex exec failed (exit ${r.status}): ${clip(r.stderr || r.stdout, 500)}`);
      }
      return readFileSync(out, 'utf8');
    },
  },
  grok: {
    describe: 'Grok Bot (not wired yet)',
    run() {
      // The seam for Grok Bot: when it has a headless command on a subscription login (ROB-403), run it here the
      // way codex is run above, read-only, prompt on stdin, reply text back.
      throw new EvaluatorError('grok: no headless Grok Bot command is wired yet (its login is ROB-403); use claude or codex');
    },
  },
};

function runCommand(command, args, { cwd, input, shell = false }) {
  const r = spawnSync(command, args, {
    cwd, input, shell, encoding: 'utf8', timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  if (r.error) {
    const why = r.error.code === 'ENOENT' ? `${command} is not installed or not on PATH` : r.error.message;
    throw new EvaluatorError(`${command}: ${why}`);
  }
  return r;
}

function injectedWorker(commandLine) {
  return (prompt, cwd) => {
    const r = runCommand(commandLine, [], { cwd, input: prompt, shell: true });
    if (r.status !== 0) {
      throw new EvaluatorError(`worker command failed (exit ${r.status}): ${clip(r.stderr || r.stdout, 500)}`);
    }
    return r.stdout;
  };
}

// --- reading the issue ------------------------------------------------------------------------------------------

export function sections(markdown) {
  const out = {};
  let current = null;
  for (const line of markdown.split(/\r?\n/)) {
    const h = /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      current = h[1].trim();
      out[current] = [];
    } else if (current) {
      out[current].push(line);
    }
  }
  return out;
}

function section(parsed, startsWith) {
  const key = Object.keys(parsed).find((k) => k.toLowerCase().startsWith(startsWith.toLowerCase()));
  return key ? parsed[key] : null;
}

// A list item: "- x", "* x", "+ x", "- [ ] x", or numbered, "1. x" or "1) x" (ROB-407, dispatch 3:
// CMD-86 numbers its criteria, and the evaluator stopped the run after a 134-minute worker cycle).
export const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;

function listItems(lines) {
  return (lines || [])
    .map((l) => LIST_ITEM.exec(l))
    .filter(Boolean)
    .map((m) => m[1]);
}

export function parseIssue(markdown) {
  const parsed = sections(markdown);
  const criteria = listItems(section(parsed, 'Acceptance criteria')).map((text, i) => ({ id: `AC${i + 1}`, text }));
  // Touches as a list (templates/issue.md) or as one line of `paths` (as many Linear issues write it,
  // CMD-21's among them). Read only as a list, the check silently did not run in ROB-407 dispatches 1 and 2.
  const touchLines = section(parsed, 'Touches') || [];
  let touches = listItems(touchLines).flatMap(touchPaths);
  if (touches.length === 0) touches = touchLines.flatMap((l) => [...l.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim()));
  return { criteria, touches };
}

// "CrankHarness: `evaluator/**` (new)" -> ["evaluator/**"]; "src/app.js (edit)" -> ["src/app.js"].
export function touchPaths(item) {
  const ticked = [...item.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
  if (ticked.length) return ticked;
  const word = item.split(/\s+/).find((w) => !w.endsWith(':'));
  return word ? [word] : [];
}

export function globToRegExp(glob) {
  // "engine/" is the folder, as dispatch and the hooks read it (CMD-21, dispatch 1).
  const g = glob.replace(/^\.\//, '').replace(/\/\.\.\.$/, '/**').replace(/(.)\/$/, '$1/**');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      re += '.*';
      i++;
      if (g[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  // A plain path also covers everything under it, so "evaluator" leases "evaluator/x.mjs".
  const plain = !/[*?]/.test(g);
  return new RegExp(`^${re}${plain ? '(?:/.*)?' : ''}$`);
}

export function outsideTouches(files, touches) {
  const patterns = touches.map(globToRegExp);
  return files.filter((f) => !patterns.some((p) => p.test(f)));
}

// The files a worker may write outside its Touches are the hooks' (hooks/rules.json, scope.outside_touches):
// always PROGRESS.md and for-rob/**, and new test files. The evaluator reads the same list, so the fence and
// the judge agree (CMD-21, dispatch 1: the hooks allowed for-rob/CMD-21.md and this check would have refused it).
const DEFAULT_ALLOWED = { always: ['PROGRESS.md', 'for-rob/**'], newTests: ['**/*.test.*', '**/*.spec.*', 'tests/**', 'test/**', '**/__tests__/**'] };

export function allowedOutsideTouches(rulesPath = join(HERE, '..', 'hooks', 'rules.json')) {
  try {
    const scope = JSON.parse(readFileSync(rulesPath, 'utf8')).scope?.outside_touches;
    if (scope) return { always: scope.always_writable || [], newTests: scope.new_tests || [] };
  } catch {
    // No hooks here: the defaults, which are the hooks' own.
  }
  return DEFAULT_ALLOWED;
}

// changed: [{ status, path }] from git diff --name-status. A new test file is allowed; an edited one is not.
export function outsideTouchesAllowing(changed, touches, allowed = allowedOutsideTouches()) {
  const always = allowed.always.map(globToRegExp);
  const tests = allowed.newTests.map(globToRegExp);
  const rest = changed.filter((c) => !always.some((p) => p.test(c.path)) && !(c.status === 'A' && tests.some((p) => p.test(c.path))));
  return outsideTouches(rest.map((c) => c.path), touches);
}

// --- reading the branch, through git objects only ---------------------------------------------------------------

function git(repo, args, { allowFail = false } = {}) {
  const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new EvaluatorError(`git: ${r.error.message}`);
  if (r.status !== 0) {
    if (allowFail) return null;
    throw new EvaluatorError(`git ${args.join(' ')} failed: ${clip(r.stderr, 300)}`);
  }
  return r.stdout;
}

function refExists(repo, ref) {
  return git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) !== null;
}

function resolveBase(repo, base) {
  if (base) {
    if (!refExists(repo, base)) throw new EvaluatorError(`base ref not found: ${base}`);
    return base;
  }
  for (const candidate of ['origin/main', 'main', 'origin/master', 'master']) {
    if (refExists(repo, candidate)) return candidate;
  }
  throw new EvaluatorError('no base ref: none of origin/main, main, origin/master, master exists; pass --base');
}

function showFile(repo, branch, path) {
  return git(repo, ['show', `${branch}:${path}`], { allowFail: true });
}

// --- the run folder ---------------------------------------------------------------------------------------------

function runFolderFiles(runDir) {
  if (!existsSync(runDir)) return [];
  const out = [];
  const walk = (dir, rel) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else out.push(r);
    }
  };
  walk(runDir, '');
  return out;
}

// --- the verdict ------------------------------------------------------------------------------------------------

export function extractJson(text) {
  const fences = [...String(text).matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fences.reverse();
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch { /* try the next one */ }
  }
  return null;
}

// Combines the worker's answer with the checks the script makes itself. The script's own checks win: the worker
// cannot talk its way past a missing test-results file or a file outside Touches.
export function decide({ expected, reply, fixed }) {
  const answered = new Map();
  for (const c of Array.isArray(reply?.criteria) ? reply.criteria : []) {
    if (c && typeof c.id === 'string') answered.set(c.id, c);
  }
  const notes = [];
  const criteria = expected.map(({ id, text }) => {
    if (fixed[id]) return { id, text, ...fixed[id] };
    const a = answered.get(id);
    if (!a) return { id, text, met: false, evidence: 'The evaluator gave no finding for this criterion (default FAIL).' };
    return { id, text, met: a.met === true, evidence: String(a.evidence ?? '').trim() || '(no evidence given)' };
  });
  const remediation = Array.isArray(reply?.remediation) ? reply.remediation.map(String).filter(Boolean) : [];
  for (const id of Object.keys(fixed)) {
    if (fixed[id].met === false && fixed[id].remediation) remediation.push(fixed[id].remediation);
  }
  const allMet = criteria.every((c) => c.met);
  const said = reply?.verdict === 'PASS' ? 'PASS' : 'NEEDS_WORK';
  if (said === 'PASS' && !allMet) notes.push('The model said PASS but at least one criterion is not met, so the verdict is NEEDS_WORK.');
  const verdict = said === 'PASS' && allMet ? 'PASS' : 'NEEDS_WORK';
  if (verdict === 'NEEDS_WORK' && remediation.length === 0) {
    for (const c of criteria.filter((x) => !x.met)) remediation.push(`Meet ${c.id}: ${c.text}`);
  }
  if (reply?.notes) notes.unshift(String(reply.notes).trim());
  for (const c of criteria) delete c.remediation;
  return { verdict, criteria, remediation, notes: notes.join(' ') };
}

// --- the whole run ----------------------------------------------------------------------------------------------

export function evaluate({ repo, issue, branch, provider = 'claude', issueFile, base, runWorker, log = () => {} }) {
  if (!repo || !issue || !branch) throw new EvaluatorError('--repo, --issue and --branch are required');
  repo = resolve(repo);
  if (!/^[A-Za-z][A-Za-z0-9]*-\d+$/.test(issue)) throw new EvaluatorError(`not an issue key: ${issue}`);
  // A project may name Codex by its family, "gpt" (project-cmd's WORKFLOW.md and labels).
  if (provider === 'gpt' || provider === 'openai') provider = 'codex';
  if (!runWorker && !PROVIDERS[provider]) {
    throw new EvaluatorError(`unknown provider: ${provider} (one of ${Object.keys(PROVIDERS).join(', ')})`);
  }
  if (git(repo, ['rev-parse', '--git-dir'], { allowFail: true }) === null) throw new EvaluatorError(`not a git repository: ${repo}`);
  if (!refExists(repo, branch)) throw new EvaluatorError(`branch not found in ${repo}: ${branch}`);
  const baseRef = resolveBase(repo, base);

  const runDir = join(repo, '.harness', 'runs', issue);
  const issuePath = issueFile ? resolve(issueFile) : join(runDir, 'issue.md');
  if (!existsSync(issuePath)) {
    throw new EvaluatorError(`no issue text: ${issuePath} does not exist (pass --issue-file, or the dispatch writes issue.md in the run folder)`);
  }
  const issueText = readFileSync(issuePath, 'utf8');
  const { criteria: acceptance, touches } = parseIssue(issueText);
  if (acceptance.length === 0) throw new EvaluatorError(`the issue has no acceptance criteria (no list under "## Acceptance criteria"): ${issuePath}`);

  const range = `${baseRef}...${branch}`;
  const diff = git(repo, ['diff', '--no-color', '--no-ext-diff', range]);
  const changed = git(repo, ['diff', '--name-status', '--no-renames', range]).split('\n').filter(Boolean)
    .map((l) => { const [status, ...p] = l.split('\t'); return { status, path: p.join('\t') }; });
  const stat = git(repo, ['diff', '--stat=120', range]).trim();

  // The run folder's evidence: the test results (default FAIL when there are none) and screenshots or traces.
  const runFiles = runFolderFiles(runDir);
  const testFiles = runFiles.filter((f) => /^test-results/i.test(f.split('/').pop()));
  const artifacts = runFiles.filter((f) => ARTIFACT.test(f) && !testFiles.includes(f));

  const fixed = {};
  if (testFiles.length === 0) {
    fixed['test-results'] = {
      met: false,
      evidence: `No test-results file in ${relRun(issue)} (default FAIL).`,
      remediation: `Run the tests and save their output as ${relRun(issue)}/test-results.txt (or .json).`,
    };
  }
  if (touches.length) {
    const outside = outsideTouchesAllowing(changed, touches);
    fixed.touches = outside.length
      ? {
          met: false,
          evidence: `Files outside Touches (${touches.join(', ')}): ${outside.join(', ')}.`,
          remediation: `Revert the changes to ${outside.join(', ')}, or get them added to the issue's Touches.`,
        }
      : { met: true, evidence: `All ${changed.length} changed files are inside Touches (${touches.join(', ')}).` };
  }

  const expected = [
    ...acceptance,
    { id: 'test-results', text: 'The test results exist, the tests ran and they passed.' },
    { id: 'verification-gap', text: 'The tests prove the behavior the issue asks for, not just that the code runs.' },
    ...(touches.length ? [{ id: 'touches', text: 'The diff stays inside the Touches list.' }] : []),
  ];

  let reply;
  let prompt = '';
  let replyText = '';
  if (changed.length === 0) {
    // Nothing to judge: no model call.
    for (const e of expected) fixed[e.id] = { met: false, evidence: `The branch has no changes against ${baseRef}.` };
    reply = { verdict: 'NEEDS_WORK', remediation: [`The branch ${branch} has no commits beyond ${baseRef}; do the work and push it.`] };
  } else {
    const bundle = mkdtempSync(join(tmpdir(), 'crankharness-eval-'));
    try {
      const bundleFiles = buildBundle({ bundle, repo, branch, issueText, diff, changed, runDir, testFiles, artifacts });
      prompt = renderPrompt({
        issue, branch, base: baseRef, issueText, expected, fixed, stat, diff, runDir, testFiles,
        projectKnowledge: projectKnowledge(repo, branch), bundleFiles,
      });
      const worker = runWorker
        || (process.env.CRANKHARNESS_EVALUATOR_CMD ? injectedWorker(process.env.CRANKHARNESS_EVALUATOR_CMD) : null)
        || ((p, cwd) => PROVIDERS[provider].run(p, cwd));
      log(`evaluator: ${issue} ${branch} vs ${baseRef}, ${changed.length} files, worker ${runWorker || process.env.CRANKHARNESS_EVALUATOR_CMD ? 'injected' : PROVIDERS[provider].describe}`);
      replyText = String(worker(prompt, bundle) ?? '');
    } finally {
      rmSync(bundle, { recursive: true, force: true });
    }
    reply = extractJson(replyText);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, 'evaluation.prompt.md'), prompt);
    writeFileSync(join(runDir, 'evaluation.reply.txt'), replyText);
    if (!reply) throw new EvaluatorError(`the worker's reply has no JSON object; it is saved in ${relRun(issue)}/evaluation.reply.txt`);
  }

  const decided = decide({ expected, reply, fixed });
  const result = { issue, branch, base: baseRef, provider: runWorker || process.env.CRANKHARNESS_EVALUATOR_CMD ? `${provider} (injected worker)` : provider, ...decided };
  // Keep the shape the dispatch script reads: verdict, criteria, notes; remediation is the list it feeds back.
  const ordered = {
    issue: result.issue, branch: result.branch, base: result.base, provider: result.provider, verdict: result.verdict,
    criteria: result.criteria, remediation: result.remediation, notes: result.notes,
  };
  mkdirSync(runDir, { recursive: true });
  const out = join(runDir, 'evaluation.json');
  if (existsSync(out)) renameSync(out, join(runDir, 'evaluation.prev.json'));
  writeFileSync(out, `${JSON.stringify(ordered, null, 2)}\n`);
  return { ...ordered, path: out };
}

function relRun(issue) {
  return `.harness/runs/${issue}`;
}

function buildBundle({ bundle, repo, branch, issueText, diff, changed, runDir, testFiles, artifacts }) {
  const listed = [];
  const put = (rel, content) => {
    const p = join(bundle, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    listed.push(rel);
  };
  put('issue.md', issueText);
  put('diff.patch', diff);
  for (const { status, path } of changed) {
    if (status.startsWith('D')) continue;
    const content = showFile(repo, branch, path);
    if (content === null || content.length > MAX_FILE || content.includes('\u0000')) continue;
    put(`branch/${path}`, content);
  }
  for (const f of [...testFiles, ...artifacts]) {
    const src = join(runDir, f);
    if (statSync(src).size > MAX_ARTIFACT) continue;
    const dest = join(bundle, 'run', f);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest);
    listed.push(`run/${f}`);
  }
  return listed;
}

function projectKnowledge(repo, branch) {
  const parts = [];
  const workflow = showFile(repo, branch, 'WORKFLOW.md');
  if (workflow === null) return 'The branch has no WORKFLOW.md. Judge from the issue, the diff and the test results only.';
  parts.push(`### WORKFLOW.md\n\n${clip(workflow, 20_000)}`);
  const fm = parseFrontMatter(workflow);
  const verify = (fm.data && typeof fm.data.verify === 'object' && fm.data.verify) || {};
  for (const [label, path] of [['verify skill', verify.skill], ['feature map', verify.feature_map]]) {
    if (typeof path !== 'string') continue;
    const text = showFile(repo, branch, path);
    parts.push(text === null
      ? `### ${label}: ${path}\n\nNot on the branch${verify.pending ? ` (pending: ${verify.pending})` : ''}.`
      : `### ${label}: ${path}\n\n${clip(text, 20_000)}`);
  }
  return parts.join('\n\n');
}

function renderPrompt({ issue, branch, base, issueText, expected, fixed, stat, diff, runDir, testFiles, projectKnowledge: pk, bundleFiles }) {
  const template = readFileSync(join(HERE, 'prompt.md'), 'utf8');
  const criteriaList = expected.map((c) => {
    const f = fixed[c.id];
    const already = f ? ` (already decided by the script: ${f.met ? 'met' : 'NOT met'}: ${f.evidence} Report it as given.)` : '';
    return `- \`${c.id}\`: ${c.text}${already}`;
  }).join('\n');
  const tests = testFiles.length
    ? testFiles.map((f) => `### ${f}\n\n\`\`\`text\n${clip(readFileSync(join(runDir, f), 'utf8'), MAX_TEST_OUTPUT)}\n\`\`\``).join('\n\n')
    : 'There is no test-results file in the run folder. That is a fail for `test-results` (default FAIL).';
  const diffText = diff.length > MAX_DIFF
    ? `${diff.slice(0, MAX_DIFF)}\n... (cut at ${MAX_DIFF} characters; the full diff is diff.patch in your working folder)`
    : diff;
  const values = {
    ISSUE: issue, BRANCH: branch, BASE: base, ISSUE_TEXT: issueText.trim(), CRITERIA_LIST: criteriaList,
    DIFF_STAT: `\`\`\`text\n${stat}\n\`\`\``, DIFF: diffText.replace(/```/g, '`​``'), TEST_RESULTS: tests,
    PROJECT_KNOWLEDGE: pk, BUNDLE_FILES: bundleFiles.map((f) => `- \`${f}\``).join('\n'),
  };
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

function clip(s, n) {
  const t = String(s ?? '');
  return t.length > n ? `${t.slice(0, n)}...` : t;
}

// --- the command line -------------------------------------------------------------------------------------------

export function main(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        repo: { type: 'string' }, issue: { type: 'string' }, branch: { type: 'string' },
        provider: { type: 'string', default: 'claude' }, 'issue-file': { type: 'string' }, base: { type: 'string' },
      },
      strict: true,
    }));
  } catch (e) {
    process.stderr.write(`evaluate: ${e.message}\nusage: node evaluator/evaluate.mjs --repo <path> --issue <KEY> --branch <name> [--provider claude|codex|grok] [--issue-file <path>] [--base <ref>]\n`);
    return 2;
  }
  try {
    const r = evaluate({
      repo: args.repo, issue: args.issue, branch: args.branch, provider: args.provider,
      issueFile: args['issue-file'], base: args.base, log: (m) => process.stderr.write(`${m}\n`),
    });
    for (const c of r.criteria) process.stdout.write(`  ${c.met ? 'met    ' : 'NOT met'}  ${c.id}: ${clip(c.evidence, 160)}\n`);
    process.stdout.write(`${r.verdict}  (${r.path})\n`);
    return r.verdict === 'PASS' ? 0 : 1;
  } catch (e) {
    process.stderr.write(`evaluate: error: ${e.message}\n`);
    if (!(e instanceof EvaluatorError)) process.stderr.write(`${e.stack}\n`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
