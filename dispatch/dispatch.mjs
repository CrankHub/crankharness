#!/usr/bin/env node
// dispatch: one issue in, one draft PR out (ROB-404).
//
//   node dispatch/dispatch.mjs --repo <checkout> --issue <KEY> [--issue-file <path>]
//                              [--provider claude|codex|grok] [--model <name>] [--dry-run]
//                              [--worker-cmd <command>] [--gh-cmd <command>]
//
// Steps, in order: the contract check; WORKFLOW.md; the worktree and branch; the hooks; the
// headless worker; the local gate; the evaluator (the worker remediates on a failure, up to the
// caps); push and a draft PR; the run record <repo>/.harness/runs/<KEY>/dispatch.json.
//
// The script never reads the tracker and never holds a key: the issue text comes from
// --issue-file, the worker runs on its own subscription login, and gh runs on Rob's login.
// Posting the PR link on the issue and moving its state are left to the caller ("next" in the
// run record).
//
// Exit 0: a draft PR was opened (or, with --dry-run, the plan printed). 1: refused or stopped.
// 2: a usage error or an unexpected failure.
//
// A command given with --worker-cmd and the like is a JSON array (["node","w.mjs"]) or words
// split on spaces ("node w.mjs"). The worker gets its prompt on stdin, runs in the worktree, and
// also finds it in the file named by CRANKHARNESS_PROMPT_FILE.

import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, copyFileSync, statSync, readdirSync, renameSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { checkContract, parseFrontMatter } from '../check-contract.mjs';

export const HARNESS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const PROVIDERS = ['claude', 'codex', 'grok'];
// Projects name a provider by its family: project-cmd's labels and WORKFLOW.md say "gpt" for what the
// harness runs as the Codex CLI (ROB-407, dispatch 2: "--provider gpt" was refused).
export const PROVIDER_ALIASES = { gpt: 'codex', openai: 'codex' };
// Providers the evaluator can run today (evaluator/evaluate.mjs); grok waits on ROB-403.
export const EVALUATOR_PROVIDERS = ['claude', 'codex'];

export function canonicalProvider(name) {
  const n = String(name || '').toLowerCase();
  return PROVIDER_ALIASES[n] ?? n;
}
// What a claude worker may use without asking. The hooks (ROB-405) are the guard on what Bash
// may do and which files may be written; this list only keeps the session headless.
export const CLAUDE_TOOLS = ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash'];
const MAX_BUFFER = 256 * 1024 * 1024;

class UsageError extends Error {}
class StopError extends Error {}

// --- arguments --------------------------------------------------------------------------------

export function parseArgs(argv) {
  const opts = { provider: 'claude', dryRun: false, resume: false };
  const valued = {
    '--repo': 'repo',
    '--issue': 'issue',
    '--issue-file': 'issueFile',
    '--provider': 'provider',
    '--evaluator': 'evaluator',
    '--model': 'model',
    '--ready-note': 'readyNote',
    '--worker-cmd': 'workerCmd',
    '--gh-cmd': 'ghCmd',
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--resume') {
      opts.resume = true;
    } else if (a in valued) {
      if (i + 1 >= argv.length) throw new UsageError(`${a} needs a value`);
      opts[valued[a]] = argv[i + 1];
      i += 1;
    } else {
      throw new UsageError(`unknown argument: ${a}`);
    }
  }
  if (!opts.repo) throw new UsageError('--repo <checkout> is required');
  if (!opts.issue) throw new UsageError('--issue <KEY> is required');
  if (!/^[A-Z][A-Z0-9]*-\d+$/.test(opts.issue)) throw new UsageError(`--issue ${opts.issue} is not an issue key like CMD-21`);
  opts.providerAsNamed = opts.provider;
  opts.provider = canonicalProvider(opts.provider);
  if (!PROVIDERS.includes(opts.provider)) {
    throw new UsageError(`--provider ${opts.providerAsNamed}: one of ${PROVIDERS.join(', ')} (or ${Object.keys(PROVIDER_ALIASES).join(', ')} for codex)`);
  }
  if (opts.evaluator !== undefined) {
    opts.evaluator = canonicalProvider(opts.evaluator);
    if (!EVALUATOR_PROVIDERS.includes(opts.evaluator)) throw new UsageError(`--evaluator ${opts.evaluator}: one of ${EVALUATOR_PROVIDERS.join(', ')}`);
  }
  opts.workerCmd ??= process.env.CRANKHARNESS_WORKER_CMD;
  opts.ghCmd ??= process.env.CRANKHARNESS_GH_CMD;
  return opts;
}

export function parseCommand(text) {
  const s = String(text).trim();
  if (s.startsWith('[')) {
    const arr = JSON.parse(s);
    if (!Array.isArray(arr) || arr.length === 0 || !arr.every((x) => typeof x === 'string')) {
      throw new UsageError(`not a command: ${s}`);
    }
    return arr;
  }
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] ?? m[2]);
  if (out.length === 0) throw new UsageError('an empty command');
  return out;
}

// --- the issue ---------------------------------------------------------------------------------

export function slugify(title, max = 40) {
  const words = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  let slug = '';
  for (const w of words) {
    const next = slug ? `${slug}-${w}` : w;
    if (next.length > max) break;
    slug = next;
  }
  return slug || (words[0] || '').slice(0, max);
}

function section(markdown, name) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^#{1,6}\\s*${name}\\b`, 'i').test(l.trim()));
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^#{1,6}\s/.test(lines[i].trim())) break;
    out.push(lines[i]);
  }
  return out.join('\n').trim();
}

// A list item as the evaluator reads one (evaluator/evaluate.mjs LIST_ITEM): "- x", "* x", "+ x",
// or numbered, "1. x" or "1) x".
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;

// The acceptance criteria, read as the evaluator reads them. The dispatch refuses an issue whose
// criteria the evaluator cannot read, so the dry run says so, not the evaluator after the worker's
// cycle (ROB-407, dispatch 3: CMD-86 numbers its criteria; the evaluator read none after 134 minutes).
export function acceptanceCriteria(text) {
  const body = section(String(text ?? ''), 'Acceptance criteria');
  if (!body) return [];
  return body.split(/\r?\n/).map((l) => LIST_ITEM.exec(l)).filter(Boolean).map((m) => m[1]);
}

// The issue file is the issue as Markdown: a first heading "# KEY: title" (or "# title"), an
// optional "Labels: a, b" line, then the body with its sections (Goal, Touches, ...).
export function readIssue(key, file) {
  if (!file) return { key, title: null, labels: null, touches: [], body: null, source: null };
  const text = readFileSync(file, 'utf8');
  const lines = text.split(/\r?\n/);
  let title = null;
  const h1 = lines.find((l) => /^#\s+\S/.test(l));
  if (h1) title = h1.replace(/^#\s+/, '').replace(new RegExp(`^${key}\\s*[:·—-]\\s*`), '').trim();
  let labels = null;
  const lab = lines.find((l) => /^\**labels\**\s*:/i.test(l.trim()));
  if (lab) labels = lab.replace(/^[^:]*:/, '').split(',').map((s) => s.replace(/[`*]/g, '').trim()).filter(Boolean);
  const touchesText = section(text, 'Touches');
  let touches = [];
  if (touchesText) {
    // A list wins: its items are the lease, and prose beside it ("Not `x`.") is not. Without a list,
    // every `path` on the lines counts. This is how the evaluator reads it too (ROB-407, dispatch 3:
    // CMD-86's "Not `tests/qa/approved-exceptions.json`" was leased to the worker).
    const items = touchesText.split(/\r?\n/).filter((l) => LIST_ITEM.test(l));
    const source = items.length ? items.join('\n') : touchesText;
    const ticked = [...source.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
    touches = ticked.length
      ? ticked
      : touchesText.split(/[\n,]/).map((s) => s.replace(/^[\s*-]+/, '').trim()).filter(Boolean);
  }
  return { key, title, labels, touches, caps: issueCaps(section(text, 'Caps')), body: text, source: resolve(file) };
}

// The issue's own caps (ROB-407: "Per dispatch: the issue's own caps"), read from its Caps section:
// "8 cycles, 80 turns, 150 minutes", "Max wall time: 90 min", "3 on the same failure".
export function issueCaps(text) {
  if (!text) return {};
  const s = String(text).toLowerCase();
  const num = (re) => { const m = re.exec(s); return m ? Number(m[1]) : undefined; };
  const caps = {
    cycles: num(/(\d+)\s*cycles?\b/) ?? num(/max cycles:\s*(\d+)/),
    turns: num(/(\d+)\s*turns?\b/) ?? num(/max turns:\s*(\d+)/),
    wall_minutes: num(/(\d+)\s*min(?:ute)?s?\b/) ?? num(/wall time:\s*(\d+)/),
    same_failure: num(/(\d+)\s*(?:times\s*)?(?:on\s*)?the same failure/),
  };
  return Object.fromEntries(Object.entries(caps).filter(([, v]) => Number.isInteger(v) && v > 0));
}

export function touchesGlobs(touches, fallback) {
  if (!touches || touches.length === 0) return String(fallback ?? 'lane');
  return touches.map((t) => (t.endsWith('/') ? `${t}**` : t)).join(',');
}

export function branchName(pattern, key, slug) {
  return pattern
    .replace('<ISSUE-ID>', key)
    .replace('<slug>', slug || '')
    .replace(/[-/]+$/, '');
}

// --- the worker --------------------------------------------------------------------------------

export function workerCommand(provider, { override, model } = {}) {
  if (override) return { argv: parseCommand(override), via: 'injected' };
  if (provider === 'claude') {
    const argv = ['claude', '-p', '--output-format', 'json', '--permission-mode', 'acceptEdits'];
    if (model) argv.push('--model', model);
    argv.push('--allowedTools', ...CLAUDE_TOOLS);
    return { argv, via: 'claude -p' };
  }
  if (provider === 'codex') {
    const argv = [process.platform === 'win32' ? 'codex.cmd' : 'codex', 'exec', '--json', '--sandbox', 'workspace-write'];
    if (model) argv.push('--model', model);
    argv.push('-');
    return { argv, via: 'codex exec' };
  }
  return {
    pending: 'grok worker pending: no headless Grok Bot command yet (ROB-403, the Grok login); pass --worker-cmd to supply one',
  };
}

// check-contract's front-matter reader keeps YAML flow values ({a: [b, c]}) as text. This reads
// them: maps, lists and plain scalars, which is all WORKFLOW.md uses.
export function parseFlow(value) {
  if (typeof value !== 'string') return value;
  const s = value.trim();
  if (!s.startsWith('{') && !s.startsWith('[')) return value;
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i += 1; };
  const scalar = () => {
    const start = i;
    while (i < s.length && !',:]}'.includes(s[i])) i += 1;
    return s.slice(start, i).trim().replace(/^['"]|['"]$/g, '');
  };
  const node = () => {
    ws();
    if (s[i] === '[') {
      i += 1;
      const out = [];
      ws();
      while (i < s.length && s[i] !== ']') { out.push(node()); ws(); if (s[i] === ',') i += 1; ws(); }
      i += 1;
      return out;
    }
    if (s[i] === '{') {
      i += 1;
      const out = {};
      ws();
      while (i < s.length && s[i] !== '}') {
        const k = scalar();
        ws();
        if (s[i] === ':') i += 1;
        out[k] = node();
        ws();
        if (s[i] === ',') i += 1;
        ws();
      }
      i += 1;
      return out;
    }
    return scalar();
  };
  try {
    return node();
  } catch {
    return value;
  }
}

// Who judges the worker's change: the first provider in WORKFLOW.md's providers.evaluate list for the
// worker's provider that the evaluator can run and that is not the worker's own. Otherwise the worker's
// own provider, said so in the record. --evaluator overrides. (ROB-407, dispatch 1, follow-up F.)
export function chooseEvaluator({ providers, worker, workerAsNamed, override }) {
  if (override) return { provider: override, why: 'given with --evaluator' };
  const lists = parseFlow(providers?.evaluate) || {};
  const key = [workerAsNamed, worker, worker === 'codex' ? 'gpt' : null].find((k) => k && lists[k]);
  const list = key ? parseFlow(lists[key]) : [];
  for (const name of Array.isArray(list) ? list : []) {
    const p = canonicalProvider(name);
    if (EVALUATOR_PROVIDERS.includes(p) && p !== worker) return { provider: p, why: `WORKFLOW.md providers.evaluate.${key}` };
  }
  const own = EVALUATOR_PROVIDERS.includes(worker) ? worker : 'claude';
  return { provider: own, why: key ? `no runnable provider in WORKFLOW.md providers.evaluate.${key} other than the worker's` : 'WORKFLOW.md names no evaluator: the worker\'s own provider' };
}

// What a worker reported. claude -p prints one JSON object; codex exec --json prints events, one per
// line: the last agent_message is its summary, and turn.completed carries the usage.
export function readWorkerOutput(provider, out) {
  if (provider === 'codex') {
    const events = String(out).split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    if (!events.length) return {};
    const items = events.filter((e) => e.type === 'item.completed' && e.item);
    const messages = items.filter((e) => e.item.type === 'agent_message' && typeof e.item.text === 'string');
    const usage = events.filter((e) => e.type === 'turn.completed' && e.usage).map((e) => e.usage);
    const result = {
      turns: usage.length,
      steps: items.length,
      session_id: events.find((e) => e.type === 'thread.started')?.thread_id,
    };
    if (usage.length) result.usage = usage.reduce((a, u) => { for (const [k, v] of Object.entries(u)) if (typeof v === 'number') a[k] = (a[k] || 0) + v; return a; }, {});
    if (messages.length) result.summary = messages[messages.length - 1].item.text;
    return result;
  }
  const json = readJson(out);
  if (!json || typeof json !== 'object') return {};
  return {
    turns: Number.isInteger(json.num_turns) ? json.num_turns : undefined,
    usage: json.usage,
    session_id: json.session_id,
    summary: typeof json.result === 'string' ? json.result : undefined,
  };
}

// --- running things ----------------------------------------------------------------------------

function quoteWin(a) {
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '""')}"` : a;
}

export function run(argv, { cwd, input, env, timeout } = {}) {
  let [cmd, ...args] = argv;
  let extra = {};
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd)) {
    args = ['/d', '/s', '/c', `"${[cmd, ...args].map(quoteWin).join(' ')}"`];
    cmd = 'cmd.exe';
    extra = { windowsVerbatimArguments: true };
  }
  const started = Date.now();
  const r = spawnSync(cmd, args, {
    cwd,
    input,
    env: env ? { ...process.env, ...env } : process.env,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout,
    windowsHide: true,
    ...extra,
  });
  return {
    code: r.status ?? (r.error ? 127 : 1),
    out: r.stdout || '',
    err: (r.stderr || '') + (r.error ? `\n${r.error.message}` : ''),
    timedOut: r.error?.code === 'ETIMEDOUT',
    seconds: Math.round((Date.now() - started) / 100) / 10,
  };
}

// The gate is a shell command. On Windows, use Git's own bash: a bare "bash" can be WSL's.
export function bashPath() {
  if (process.platform !== 'win32') return 'bash';
  const r = run(['git', '--exec-path']);
  if (r.code === 0) {
    const root = resolve(r.out.trim(), '..', '..', '..');
    for (const p of [join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe')]) if (existsSync(p)) return p;
  }
  return 'bash';
}

function git(args, cwd) {
  return run(['git', ...args], { cwd });
}

function gitOk(args, cwd) {
  const r = git(args, cwd);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.err || r.out).trim()}`);
  return r.out.trim();
}

function tail(text, n = 40) {
  const lines = String(text).replace(/\s+$/, '').split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

// --- the plan ----------------------------------------------------------------------------------

function baseRef(repo) {
  const hasOrigin = git(['remote', 'get-url', 'origin'], repo).code === 0;
  if (hasOrigin) {
    const head = git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], repo);
    if (head.code === 0 && head.out.trim()) {
      const ref = head.out.trim();
      return { hasOrigin, ref, branch: ref.replace(/^origin\//, '') };
    }
    for (const b of ['main', 'master']) {
      if (git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${b}`], repo).code === 0) {
        return { hasOrigin, ref: `origin/${b}`, branch: b };
      }
    }
    return { hasOrigin, ref: 'origin/main', branch: 'main' };
  }
  for (const b of ['main', 'master']) {
    if (git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], repo).code === 0) return { hasOrigin, ref: b, branch: b };
  }
  return { hasOrigin, ref: 'HEAD', branch: 'main' };
}

function optionalCommand(file) {
  const path = join(HARNESS_ROOT, file);
  if (existsSync(path)) return { argv: [process.execPath, path], present: true, via: file };
  return { argv: null, present: false, via: file };
}

export function makePlan(opts) {
  const repo = resolve(opts.repo);
  const key = opts.issue;
  const refusals = [];
  const notes = [];
  const plan = { repo, key, provider: opts.provider, providerAsNamed: opts.providerAsNamed ?? opts.provider, dryRun: opts.dryRun, refusals, notes };

  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    refusals.push(`${repo} is not a directory`);
    return plan;
  }
  if (git(['rev-parse', '--show-toplevel'], repo).code !== 0) {
    refusals.push(`${repo} is not a git repository`);
    return plan;
  }

  // 1. The contract.
  plan.contract = checkContract(repo);
  if (!plan.contract.pass) refusals.push(`the repository fails the contract: ${plan.contract.missing} missing (CONTRACT.md)`);

  // 2. WORKFLOW.md.
  const wfPath = join(repo, 'WORKFLOW.md');
  if (existsSync(wfPath)) {
    const text = readFileSync(wfPath, 'utf8');
    const parsed = parseFrontMatter(text);
    if (!parsed.error) {
      const wf = parsed.data;
      plan.workflow = {
        sha256: sha256(text),
        ready_label: wf.tracker?.ready_label || 'agent-ready',
        branch_pattern: wf.branch?.pattern,
        gate: wf.gate?.local,
        touches_default: wf.touches?.default,
        providers: wf.providers,
        caps: {
          cycles: wf.caps?.cycles ?? 8,
          same_failure: wf.caps?.same_failure ?? 3,
          turns: wf.caps?.turns ?? 80,
          wall_minutes: wf.caps?.wall_minutes ?? 90,
        },
      };
    }
  }
  if (!plan.workflow) return plan;

  // The issue.
  if (opts.issueFile && !existsSync(opts.issueFile)) {
    refusals.push(`--issue-file ${opts.issueFile} does not exist`);
    return plan;
  }
  plan.issue = readIssue(key, opts.issueFile);
  if (!plan.issue.body) {
    if (opts.dryRun) notes.push('no --issue-file: a real dispatch needs one (the issue body is the spec; this script never reads the tracker)');
    else refusals.push('no --issue-file: the issue body is the spec, and this script never reads the tracker');
  }
  // Ready by label, or set aside for the harness and kept out of that label on purpose, so the
  // project's own workers do not take it (ROB-407, dispatch 3: CMD-86). A set-aside issue needs
  // --ready-note naming who set it aside; the note goes in the record and the PR.
  plan.readyNote = opts.readyNote ?? null;
  if (plan.issue.labels) {
    if (!plan.issue.labels.includes(plan.workflow.ready_label)) {
      if (plan.readyNote) {
        notes.push(`not labeled ${plan.workflow.ready_label}; ready by: ${plan.readyNote}`);
      } else {
        refusals.push(`${key} is not labeled ${plan.workflow.ready_label} (labels: ${plan.issue.labels.join(', ') || 'none'}); if it was set aside for the harness instead, say by whom with --ready-note`);
      }
    }
  } else {
    notes.push(`labels not checked: the issue file has no "Labels:" line (the caller checks ${plan.workflow.ready_label})`);
  }
  notes.push('blockers not checked here: the caller confirms every blocker is merged before dispatching');

  // The names.
  plan.slug = slugify(plan.issue.title);
  plan.branch = branchName(plan.workflow.branch_pattern, key, plan.slug);
  plan.base = baseRef(repo);
  plan.worktree = join(repo, '.harness', 'worktrees', key);
  plan.runDir = join(repo, '.harness', 'runs', key);
  plan.touches = touchesGlobs(plan.issue.touches, plan.workflow.touches_default);
  // The issue's own caps win over WORKFLOW.md's defaults.
  plan.capsFromIssue = plan.issue.caps || {};
  plan.workflow.caps = { ...plan.workflow.caps, ...plan.capsFromIssue };
  plan.gate = String(plan.workflow.gate).replace(/<ref>/g, plan.branch);

  // The parts.
  plan.hooks = optionalCommand('hooks/install.mjs');
  plan.evaluator = optionalCommand('evaluator/evaluate.mjs');
  plan.worker = workerCommand(opts.provider, { override: opts.workerCmd, model: opts.model });
  plan.judge = chooseEvaluator({ providers: plan.workflow.providers, worker: opts.provider, workerAsNamed: plan.providerAsNamed, override: opts.evaluator });
  if (plan.worker.pending) refusals.push(plan.worker.pending);
  if (plan.issue.body && plan.evaluator.present) {
    plan.issue.criteria = acceptanceCriteria(plan.issue.body).length;
    if (plan.issue.criteria === 0) {
      refusals.push('the issue file has no acceptance criteria the evaluator can read: a list ("- x" or "1. x") under "## Acceptance criteria"');
    }
  }
  plan.resume = Boolean(opts.resume);
  if (plan.resume) notes.push('--resume: cycle 1 judges the work the branch already holds; the worker does not run again until a cycle fails');
  if (opts.provider === 'codex' && !opts.workerCmd) {
    notes.push('codex worker: the hooks are Claude Code settings and do not fence it; its workspace-write sandbox, the gate and the evaluator\'s Touches check do');
  }
  plan.gh = opts.ghCmd ? parseCommand(opts.ghCmd) : ['gh'];
  if (!plan.base.hasOrigin) notes.push('no origin remote: the branch starts from the local main, and push and the PR will stop the run');
  return plan;
}

function hooksArgv(plan) {
  const argv = [...plan.hooks.argv, '--worktree', plan.worktree, '--phase', 'implement', '--touches', plan.touches];
  const caps = Object.entries(plan.capsFromIssue || {}).map(([k, v]) => `${k}=${v}`).join(',');
  if (caps) argv.push('--caps', caps);
  return argv;
}

// The evaluator reads its evidence from <repo>/.harness/runs/<KEY>/ of the repo it is given, which
// is the worktree: the issue comes by --issue-file, the gate output as test-results.txt there.
function evaluatorArgv(plan) {
  const argv = [...plan.evaluator.argv, '--repo', plan.worktree, '--issue', plan.key, '--branch', plan.branch, '--provider', plan.judge.provider];
  if (plan.issue.source) argv.push('--issue-file', plan.issue.source);
  return argv;
}

export function evaluatorEvidenceDir(plan) {
  return join(plan.worktree, '.harness', 'runs', plan.key);
}

// What goes back to the worker after NEEDS_WORK: the unmet criteria, the remediation and the notes
// (the evaluator's fields, evaluator/README.md), or summary and findings from an older evaluator.
export function evaluationFeedback(evaluation) {
  if (!evaluation || typeof evaluation !== 'object') return null;
  const out = {};
  if (Array.isArray(evaluation.criteria)) {
    const unmet = evaluation.criteria.filter((c) => c && c.met === false);
    if (unmet.length) out.unmet = unmet.map((c) => ({ id: c.id, text: c.text, evidence: c.evidence }));
  }
  if (Array.isArray(evaluation.remediation) && evaluation.remediation.length) out.remediation = evaluation.remediation;
  if (evaluation.notes) out.notes = evaluation.notes;
  if (evaluation.summary) out.summary = evaluation.summary;
  if (evaluation.findings) out.findings = evaluation.findings;
  return Object.keys(out).length ? JSON.stringify(out, null, 2) : null;
}

function prTitle(plan) {
  return plan.issue.title ? `${plan.key}: ${plan.issue.title}` : plan.key;
}

function show(argv) {
  return argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

export function renderPlan(plan) {
  const out = [`dispatch${plan.dryRun ? ' (dry run)' : ''}: ${plan.key} on ${plan.repo}`];
  if (plan.contract) {
    const c = plan.contract;
    out.push(`  contract   ${c.pass ? (c.pending ? `PASS (${c.pending} pending)` : 'PASS') : `FAIL: ${c.missing} missing`}`);
    for (const l of c.lines) out.push(`           ${l.trim()}`);
  }
  if (plan.workflow) {
    const k = plan.workflow.caps;
    out.push(`  workflow   WORKFLOW.md sha256 ${plan.workflow.sha256.slice(0, 12)}; caps: ${k.cycles} cycles, stop after ${k.same_failure} on the same failure, ${k.turns} turns, ${k.wall_minutes} min${Object.keys(plan.capsFromIssue || {}).length ? ` (from the issue: ${Object.keys(plan.capsFromIssue).join(', ')})` : ''}`);
  }
  if (plan.issue) {
    out.push(`  issue      ${prTitle(plan)}${plan.issue.source ? ` (from ${plan.issue.source})` : ''}`);
    if (plan.issue.labels) out.push(`  labels     ${plan.issue.labels.join(', ')}`);
    out.push(`  touches    ${plan.touches}`);
  }
  if (plan.branch) {
    out.push(`  branch     ${plan.branch} from ${plan.base.ref}`);
    out.push(`  worktree   ${plan.worktree}`);
    out.push(`  run folder ${plan.runDir}`);
    out.push('  exclude    .harness/ goes in .git/info/exclude (never the project .gitignore)');
    out.push('  steps');
    out.push(`    1 hooks      ${plan.hooks.present ? show(hooksArgv(plan)) : 'hooks pending (hooks/install.mjs not here yet: ROB-405)'}`);
    out.push(`    2 worker     ${plan.worker.argv ? `${show(plan.worker.argv)}  (prompt on stdin, cwd = the worktree)` : plan.worker.pending}${plan.resume ? '; skipped in cycle 1 (--resume)' : ''}`);
    out.push(`    3 gate       bash -c ${JSON.stringify(plan.gate)}  (cwd = the worktree)`);
    out.push(`    4 evaluator  ${plan.evaluator.present ? show(evaluatorArgv(plan)) : 'evaluator pending (evaluator/evaluate.mjs not here yet: ROB-406)'}`);
    out.push(`      judged by ${plan.judge.provider} (${plan.judge.why})`);
    out.push(`      on a gate failure or NEEDS_WORK the worker runs again with the failure, up to ${plan.workflow.caps.cycles} cycles`);
    out.push(`    5 push       git push -u origin ${plan.branch}`);
    out.push(`    6 draft PR   ${show(plan.gh)} pr create --draft --base ${plan.base.branch} --head ${plan.branch} --title ${JSON.stringify(prTitle(plan))}`);
    out.push(`    7 record     ${join(plan.runDir, 'dispatch.json')}`);
  }
  for (const n of plan.notes) out.push(`  note       ${n}`);
  for (const r of plan.refusals) out.push(`  REFUSED    ${r}`);
  if (plan.refusals.length) out.push(`REFUSED: ${plan.refusals.length} reason${plan.refusals.length > 1 ? 's' : ''}`);
  else if (plan.dryRun) out.push('dry run: nothing was created, run or pushed');
  return out.join('\n');
}

// --- the prompt --------------------------------------------------------------------------------

export function buildPrompt(plan, { cycle, feedback }) {
  const k = plan.workflow.caps;
  const lines = [
    `You are a CrankHarness worker. One issue, one session, this worktree, this branch.`,
    '',
    `Issue: ${prTitle(plan)}`,
    `Branch: ${plan.branch} (already checked out here; do not switch branches, do not push, do not open a PR: the harness does that)`,
    `Touches, your lease: ${plan.touches}`,
    `Cycle ${cycle} of at most ${k.cycles}.`,
    '',
    'Rules:',
    '- Read AGENTS.md and WORKFLOW.md first and follow them; the issue below is the spec.',
    '- Keep a progress file at .harness/PROGRESS.md (it is not committed): what is done, what is next, and anything for Rob. Read it first if it exists: a retry resumes from it.',
    `- Before you stop, run the local gate and make it pass: ${plan.gate}`,
    `- Commit your work on this branch; start every commit message with ${plan.key}.`,
    '- Stop and say why in .harness/PROGRESS.md if you cannot go on (a stop condition in AGENTS.md).',
  ];
  if (feedback) {
    lines.push('', `The last cycle did not pass. Fix this first:`, '', feedback);
  }
  lines.push('', '--- the issue ---', '', plan.issue.body || `(no issue text was supplied for ${plan.key})`);
  return lines.join('\n');
}

// --- the run -----------------------------------------------------------------------------------

function readJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const last = String(text).trim().split(/\r?\n/).pop();
    try {
      return JSON.parse(last);
    } catch {
      return null;
    }
  }
}

// --resume keeps the stopped run's files: they move into attempt-<n>/ beside the new run's.
function setAsideEarlierRun(runDir) {
  const files = readdirSync(runDir, { withFileTypes: true }).filter((d) => d.isFile());
  if (!files.length) return null;
  let n = 1;
  while (existsSync(join(runDir, `attempt-${n}`))) n += 1;
  const to = join(runDir, `attempt-${n}`);
  mkdirSync(to);
  for (const f of files) renameSync(join(runDir, f.name), join(to, f.name));
  return `attempt-${n}/dispatch.json`;
}

function excludeHarness(worktree) {
  const path = gitOk(['rev-parse', '--path-format=absolute', '--git-path', 'info/exclude'], worktree);
  mkdirSync(dirname(path), { recursive: true });
  const now = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (!now.split(/\r?\n/).some((l) => l.trim() === '.harness/' || l.trim() === '/.harness/')) {
    appendFileSync(path, `${now && !now.endsWith('\n') ? '\n' : ''}# CrankHarness run folders and worktrees\n.harness/\n`);
  }
  return path;
}

function prepareWorktree(plan, record) {
  const { repo, worktree, branch, base } = plan;
  if (base.hasOrigin) {
    const f = git(['fetch', 'origin'], repo);
    if (f.code !== 0) record.notes.push(`git fetch origin failed; working from what is here: ${tail(f.err, 3)}`);
  }
  const branchExists = git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo).code === 0;
  if (existsSync(join(worktree, '.git'))) {
    record.worktree_state = 'resumed';
  } else if (branchExists) {
    gitOk(['worktree', 'add', worktree, branch], repo);
    record.worktree_state = 'resumed (branch existed)';
  } else {
    gitOk(['worktree', 'add', '-b', branch, worktree, base.ref], repo);
    record.worktree_state = 'created';
  }
  if (record.worktree_state !== 'created') {
    // Catch up with main by a merge commit, never a rebase.
    const m = git(['merge', '--no-edit', base.ref], worktree);
    if (m.code !== 0) {
      git(['merge', '--abort'], worktree);
      throw new StopError(`merge of ${base.ref} into ${branch} has conflicts; resolve by hand, then dispatch again`);
    }
  }
  record.base_sha = gitOk(['rev-parse', base.ref], repo);
  record.exclude = excludeHarness(worktree);
}


function commitLeftovers(plan) {
  const status = git(['status', '--porcelain'], plan.worktree).out.trim();
  if (!status) return false;
  gitOk(['add', '-A'], plan.worktree);
  gitOk(['commit', '-m', `${plan.key}: work the worker left uncommitted (committed by dispatch)`], plan.worktree);
  return true;
}

function hasChanges(plan) {
  return git(['diff', '--quiet', `${plan.base.ref}...HEAD`], plan.worktree).code !== 0;
}

// Two failures are "the same" when they differ only in timings and hashes. Timings come in both
// orders ("12 ms", "duration_ms: 3.04"), so any decimal number and any number after a duration key
// is dropped (CMD-21, dispatch 1: TAP timings made five identical gate failures look different).
export function failureSignature(kind, text) {
  const norm = String(text)
    .replace(/\b(duration_ms|duration|elapsed|time)\b\s*[:=]?\s*\d+(\.\d+)?/gi, '$1')
    .replace(/\d+(\.\d+)?\s*(ms|s)\b/g, '')
    .replace(/\d+\.\d+/g, '')
    .replace(/[0-9a-f]{7,40}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${kind}:${sha256(norm).slice(0, 16)}`;
}

// GitHub refuses a PR body over 65,536 characters (with a bare "GraphQL: Something went wrong"). CMD-21
// changed 13,089 files and its full --stat made an 815 KB body, so the stat and the log are capped and the
// whole body is held under this limit. The full text stays in the run folder's diff.patch.
export const PR_BODY_MAX = 60000;
const STAT_FILES = 40;
const LOG_LINES = 50;

function capLines(text, n, what) {
  const lines = String(text).split('\n');
  return lines.length <= n ? text : [...lines.slice(0, n), `... and ${lines.length - n} more ${what}`].join('\n');
}

function prBody(plan, record) {
  const last = record.cycles[record.cycles.length - 1] || {};
  const log = capLines(git(['log', '--oneline', '--no-merges', `${plan.base.ref}..HEAD`], plan.worktree).out.trim(), LOG_LINES, 'commits');
  // Three dots: what the branch changes since it left main. Main moves during a run (CMD-62, dispatch 2:
  // CMD-33 merged meanwhile, and a two-dot stat showed its files as deleted by this branch).
  const stat = git(['diff', '--stat=120', `--stat-count=${STAT_FILES}`, `${plan.base.ref}...HEAD`], plan.worktree).out.trim();
  const verdict = last.evaluation?.verdict;
  const lines = [
    `Dispatched by CrankHarness (\`dispatch/dispatch.mjs\`, provider ${plan.provider}). Draft: it never merges itself.`,
    '',
    '## What shipped',
    '',
    '```text',
    log || '(no commits)',
    '',
    stat,
    '```',
    '',
  ];
  if (record.worker_summary) lines.push('The worker says:', '', `> ${record.worker_summary.split('\n').join('\n> ')}`, '');
  lines.push(
    '## Proven, and by what command',
    '',
    `- Local gate: \`${plan.gate}\` exited ${last.gate?.exit} in the worktree (cycle ${last.n}).`,
    plan.evaluator.present
      ? `- Evaluator: \`evaluator/evaluate.mjs --issue ${plan.key} --branch ${plan.branch}\` returned ${verdict ?? 'no verdict'} (exit ${last.evaluation?.exit}), judged by ${plan.judge.provider}.`
      : '- Evaluator: not yet provable (evaluator pending, ROB-406).',
    `- Contract: \`check-contract.mjs\` ${plan.contract.pass ? 'PASS' : 'FAIL'} before the run.`,
    ...(plan.readyNote ? [`- Ready: not labeled ${plan.workflow.ready_label}; ${plan.readyNote}.`] : []),
    '',
    '## Assumed, not proven',
    '',
    !plan.hooks.present
      ? '- The hooks did not guard this run (hooks pending, ROB-405).'
      : plan.provider === 'claude'
        ? '- The hooks were installed for the implement phase.'
        : `- The hooks were installed, but they are Claude Code settings: the ${plan.provider} worker ran inside its own sandbox, not the hooks.`,
    '- Everything in the issue-level definition of done that no gate above proves (`dod/issue.md`, "Which lines each phase can prove").',
    '',
    '## Outstanding',
    '',
    record.stop ? `- Stopped: ${record.stop}` : '- Nothing the run knows of.',
    `- The issue is not yet commented with this PR's link and not moved: that is the caller's (see \`next\` in the run record).`,
    '',
    '## Run folder',
    '',
    `\`.harness/runs/${plan.key}/\` in the checkout on the machine that ran the dispatch (dispatch.json, prompt, worker output, gate output, evaluation, progress file, the full diff).`,
    `Cycles: ${record.cycles.length}. First-pass PASS: ${record.first_pass_pass === null ? 'unknown (evaluator pending)' : record.first_pass_pass}.`,
  );
  const body = lines.join('\n');
  if (body.length <= PR_BODY_MAX) return body;
  const note = '\n\n(cut to fit GitHub\'s limit; the full diff is diff.patch in the run folder)';
  return body.slice(0, PR_BODY_MAX - note.length) + note;
}

export function dispatch(opts, { log = console.log } = {}) {
  const plan = makePlan(opts);
  if (opts.dryRun || plan.refusals.length) {
    log(renderPlan(plan));
    return { exit: plan.refusals.length ? 1 : 0, plan };
  }

  const started = Date.now();
  const k = plan.workflow.caps;
  const deadline = started + k.wall_minutes * 60 * 1000;
  mkdirSync(plan.runDir, { recursive: true });
  const resumedFrom = plan.resume ? setAsideEarlierRun(plan.runDir) : null;
  const record = {
    harness: 'crankharness',
    record: 'dispatch',
    version: 1,
    issue: plan.key,
    title: plan.issue.title,
    provider: plan.provider,
    provider_as_named: plan.providerAsNamed,
    worker: plan.worker.via,
    evaluator_provider: plan.judge.provider,
    evaluator_provider_why: plan.judge.why,
    repo: plan.repo,
    worktree: plan.worktree,
    branch: plan.branch,
    base: plan.base.ref,
    started_at: new Date(started).toISOString(),
    finished_at: null,
    wall_seconds: null,
    workflow: { sha256: plan.workflow.sha256, caps: k, caps_from_issue: plan.capsFromIssue, gate: plan.gate, touches: plan.touches },
    ready_note: plan.readyNote,
    contract: { pass: plan.contract.pass, pending: plan.contract.pending, lines: plan.contract.lines.map((l) => l.trim()) },
    hooks: plan.hooks.present ? 'not run' : 'hooks pending',
    evaluator: plan.evaluator.present ? 'not run' : 'evaluator pending',
    cycles: [],
    turns: 0,
    // What ROB-407 measures. first_pass_pass: the first cycle passed the gate and the evaluator
    // (null while the evaluator is pending). human_interventions: each time Rob had to step in on
    // this issue; the dispatch itself needs none, and ROB-407 adds to it.
    first_pass_gate: null,
    first_pass_pass: null,
    human_interventions: 0,
    interventions: [],
    stop: null,
    pushed: false,
    pr: null,
    final_state: 'running',
    notes: [...plan.notes],
    next: [],
  };
  if (plan.resume) record.resumed_from = resumedFrom;
  const recordPath = join(plan.runDir, 'dispatch.json');
  const save = () => writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  save();
  log(`dispatch: ${plan.key} -> ${plan.branch}`);

  let exit = 1;
  try {
    // 3. The worktree and branch.
    prepareWorktree(plan, record);
    log(`  worktree   ${record.worktree_state}: ${plan.worktree}`);
    save();

    // 4. The hooks.
    if (plan.hooks.present) {
      const h = run(hooksArgv(plan), { cwd: plan.worktree });
      writeFileSync(join(plan.runDir, 'hooks.txt'), h.out + h.err);
      if (h.code !== 0) {
        record.hooks = `failed (exit ${h.code})`;
        throw new StopError(`the hooks did not install (exit ${h.code}): ${tail(h.err || h.out, 5)}`);
      }
      record.hooks = 'installed';
    }
    log(`  hooks      ${record.hooks}`);
    save();

    // 5-7. Worker, gate, evaluator; the worker remediates until a pass or a cap.
    const seen = new Map();
    let feedback = null;
    let passed = false;
    for (let n = 1; n <= k.cycles; n += 1) {
      const cycle = { n };
      record.cycles.push(cycle);
      const left = deadline - Date.now();
      if (left <= 0) throw new StopError(`wall time cap: ${k.wall_minutes} min`);
      if (record.turns >= k.turns) throw new StopError(`turn cap: ${k.turns} turns`);

      if (n === 1 && plan.resume) {
        // The worker's earlier cycle stands; judge it (ROB-407, dispatch 3).
        if (!hasChanges(plan)) throw new StopError(`--resume: ${plan.branch} holds no work ahead of ${plan.base.ref} to judge`);
        cycle.worker = { resumed: true };
        log('  worker     cycle 1: not run (--resume: judging the work the branch holds)');
        save();
      } else {
        const prompt = buildPrompt(plan, { cycle: n, feedback });
        const promptFile = join(plan.runDir, n === 1 ? 'prompt.md' : `prompt-${n}.md`);
        writeFileSync(promptFile, prompt);
        const w = run(plan.worker.argv, {
          cwd: plan.worktree,
          input: prompt,
          timeout: left,
          env: { CRANKHARNESS_PROMPT_FILE: promptFile, CRANKHARNESS_ISSUE: plan.key, CRANKHARNESS_CYCLE: String(n) },
        });
        writeFileSync(join(plan.runDir, `worker-${n}.out.json`), w.out);
        if (w.err.trim()) writeFileSync(join(plan.runDir, `worker-${n}.err.txt`), w.err);
        const reported = readWorkerOutput(plan.worker.via === 'injected' ? 'claude' : plan.provider, w.out);
        cycle.worker = { exit: w.code, seconds: w.seconds };
        if (Number.isInteger(reported.turns)) cycle.worker.turns = reported.turns;
        if (Number.isInteger(reported.steps)) cycle.worker.steps = reported.steps;
        if (reported.usage) cycle.worker.usage = reported.usage;
        if (reported.session_id) cycle.worker.session_id = reported.session_id;
        if (reported.summary) record.worker_summary = reported.summary.slice(0, 2000);
        record.turns += cycle.worker.turns ?? 0;
        const progress = join(plan.worktree, '.harness', 'PROGRESS.md');
        if (existsSync(progress)) copyFileSync(progress, join(plan.runDir, 'PROGRESS.md'));
        log(`  worker     cycle ${n}: exit ${w.code} in ${w.seconds}s`);
        save();
        if (w.timedOut) throw new StopError(`wall time cap: ${k.wall_minutes} min (the worker was stopped)`);
        if (w.code !== 0) throw new StopError(`the worker exited ${w.code}: ${tail(w.err || w.out, 5)}`);
        cycle.committed_by_dispatch = commitLeftovers(plan);
        if (!hasChanges(plan)) throw new StopError('the worker made no change');
      }

      // 6. The local gate.
      const g = run([bashPath(), '-c', plan.gate], { cwd: plan.worktree, timeout: Math.max(deadline - Date.now(), 1000) });
      writeFileSync(join(plan.runDir, `gate-${n}.txt`), g.out + g.err);
      // The evaluator's test evidence: this cycle's gate output, where the evaluator looks for it.
      mkdirSync(evaluatorEvidenceDir(plan), { recursive: true });
      writeFileSync(
        join(evaluatorEvidenceDir(plan), 'test-results.txt'),
        `$ ${plan.gate}\n(cycle ${n}, the local gate, which runs the project's suites; exit ${g.code})\n\n${g.out}${g.err}`,
      );
      cycle.gate = { exit: g.code, seconds: g.seconds };
      log(`  gate       cycle ${n}: exit ${g.code}`);
      save();
      let failure = null;
      if (g.code !== 0) {
        failure = { sig: failureSignature('gate', tail(g.out + g.err)), text: `The local gate \`${plan.gate}\` exited ${g.code}:\n\n${tail(g.out + g.err)}` };
      } else if (plan.evaluator.present) {
        // 7. The evaluator.
        const e = run(evaluatorArgv(plan), { cwd: plan.worktree, timeout: Math.max(deadline - Date.now(), 1000) });
        writeFileSync(join(plan.runDir, `evaluator-${n}.txt`), e.out + e.err);
        const evalPath = join(plan.worktree, '.harness', 'runs', plan.key, 'evaluation.json');
        let evaluation = null;
        if (existsSync(evalPath)) {
          const text = readFileSync(evalPath, 'utf8');
          writeFileSync(join(plan.runDir, n === 1 ? 'evaluation.json' : `evaluation-${n}.json`), text);
          evaluation = readJson(text);
        }
        const verdict = { 0: 'PASS', 1: 'NEEDS_WORK' }[e.code] ?? 'error';
        cycle.evaluation = { exit: e.code, verdict };
        record.evaluator = 'ran';
        log(`  evaluator  cycle ${n}: ${verdict}`);
        save();
        if (e.code === 2 || verdict === 'error') throw new StopError(`the evaluator failed (exit ${e.code}): ${tail(e.err || e.out, 5)}`);
        if (e.code === 1) {
          const detail = evaluationFeedback(evaluation) ?? tail(e.out + e.err);
          failure = { sig: failureSignature('evaluator', detail), text: `The evaluator returned NEEDS_WORK:\n\n${detail}` };
        }
      }
      if (n === 1) {
        record.first_pass_gate = g.code === 0;
        record.first_pass_pass = plan.evaluator.present ? !failure : null;
      }
      if (!failure) {
        passed = true;
        break;
      }
      const count = (seen.get(failure.sig) || 0) + 1;
      seen.set(failure.sig, count);
      cycle.failure = failure.sig;
      if (count >= k.same_failure) throw new StopError(`the same failure ${count} times in a row (cap ${k.same_failure}): ${failure.text.split('\n')[0]}`);
      feedback = failure.text;
    }
    if (!passed) throw new StopError(`cycle cap: ${k.cycles} cycles without a pass`);

    // 8. Push and a draft PR.
    if (!plan.base.hasOrigin) throw new StopError('no origin remote to push to');
    const p = git(['push', '-u', 'origin', plan.branch], plan.worktree);
    writeFileSync(join(plan.runDir, 'push.txt'), p.out + p.err);
    if (p.code !== 0) throw new StopError(`git push failed: ${tail(p.err, 5)}`);
    record.pushed = true;
    log(`  push       origin ${plan.branch}`);
    const bodyFile = join(plan.runDir, 'pr-body.md');
    writeFileSync(bodyFile, prBody(plan, record));
    // A resumed run reuses the branch's open PR (CMD-21, dispatch 1: the PR was opened on the stop,
    // and a second "gh pr create" for the same branch fails). Its body is replaced with this run's.
    const open = run([...plan.gh, 'pr', 'view', plan.branch, '--json', 'url,state'], { cwd: plan.worktree });
    const existing = open.code === 0 ? readJson(open.out) : null;
    let pr;
    let reused = false;
    if (existing && existing.state === 'OPEN' && existing.url) {
      pr = run([...plan.gh, 'pr', 'edit', plan.branch, '--body-file', bodyFile], { cwd: plan.worktree });
      if (pr.code === 0) pr.out = `${existing.url}\n`;
      reused = true;
    } else {
      pr = run([...plan.gh, 'pr', 'create', '--draft', '--base', plan.base.branch, '--head', plan.branch, '--title', prTitle(plan), '--body-file', bodyFile], { cwd: plan.worktree });
    }
    writeFileSync(join(plan.runDir, 'pr.txt'), pr.out + pr.err);
    if (pr.code !== 0) throw new StopError(`gh pr ${reused ? 'edit' : 'create'} failed: ${tail(pr.err || pr.out, 5)}`);
    const url = (pr.out.match(/https?:\/\/\S+/g) || []).pop() || pr.out.trim();
    record.pr = { url, draft: true, title: prTitle(plan), reused };
    record.final_state = 'draft-pr';
    record.next.push(`comment the PR link on ${plan.key}: ${url}`);
    log(`  draft PR   ${url}`);
    exit = 0;
  } catch (err) {
    if (err instanceof StopError) {
      record.stop = err.message;
      record.final_state = 'stopped';
      record.next.push(`move ${plan.key} to Blocked with this note: ${err.message}`);
      log(`  STOPPED    ${err.message}`);
      exit = 1;
    } else {
      record.stop = `error: ${err.message}`;
      record.final_state = 'error';
      log(`  ERROR      ${err.message}`);
      exit = 2;
    }
  } finally {
    record.finished_at = new Date().toISOString();
    record.wall_seconds = Math.round((Date.now() - started) / 1000);
    if (existsSync(join(plan.worktree, '.git'))) {
      const d = git(['diff', `${plan.base.ref}...HEAD`], plan.worktree);
      if (d.code === 0) writeFileSync(join(plan.runDir, 'diff.patch'), d.out);
    }
    save();
    log(`  record     ${recordPath}`);
  }
  return { exit, plan, record };
}

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (err instanceof UsageError) {
      console.error(`dispatch: ${err.message}`);
      console.error('usage: node dispatch/dispatch.mjs --repo <checkout> --issue <KEY> [--issue-file <path>] [--provider claude|codex|grok] [--ready-note <who set it aside>] [--resume] [--dry-run]');
      return 2;
    }
    throw err;
  }
  try {
    return dispatch(opts).exit;
  } catch (err) {
    console.error(`dispatch: ${err.message}`);
    return 2;
  }
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exitCode = main(process.argv.slice(2));
