// The dispatch script against a scratch git repository with a local "origin", a fake worker, a
// fake gh and, where a test needs them, fake hooks and a fake evaluator. Nothing here reaches the
// network or a real worker.
//
// Each test copies dispatch.mjs and check-contract.mjs into a scratch harness folder, so whether
// hooks/install.mjs and evaluator/evaluate.mjs exist is decided by the test, not by this checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { slugify, branchName, touchesGlobs, readIssue, parseCommand, parseArgs, workerCommand, failureSignature, parseFlow, chooseEvaluator, readWorkerOutput } from '../dispatch/dispatch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const KEY = 'TST-7';

function sh(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}
const git = (cwd, ...args) => sh('git', args, cwd);

const FAKE_WORKER = `
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
const prompt = readFileSync(0, 'utf8');
const cycle = Number(process.env.CRANKHARNESS_CYCLE);
const mode = process.env.FAKE_MODE || 'good';
mkdirSync('.harness', { recursive: true });
writeFileSync('.harness/PROGRESS.md', 'cycle ' + cycle + ' done\\n');
if (mode === 'crash') { console.error('usage limit reached'); process.exit(3); }
if (mode !== 'nothing') {
  const word = mode === 'always-bad' || (mode === 'bad-then-good' && cycle === 1) ? 'bad' : 'ok';
  writeFileSync('result.txt', word + '\\n');
  if (mode === 'many') {
    // A harvest-sized change: many files with long names (CMD-21 changed 13,089).
    mkdirSync('docs/harvest', { recursive: true });
    for (let i = 0; i < 3000; i += 1) writeFileSync('docs/harvest/a-card-with-a-rather-long-file-name-' + i + '.json', '{}\\n');
  }
  if (mode !== 'leave') {
    execFileSync('git', ['add', '-A']);
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', '${KEY}: cycle ' + cycle]);
  }
}
console.log(JSON.stringify({ type: 'result', result: 'did cycle ' + cycle, num_turns: 4, session_id: 's-' + cycle, saw_issue: prompt.includes('${KEY}') }));
`;

const FAKE_GH = `
import { appendFileSync } from 'node:fs';
const a = process.argv.slice(2);
appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify(a) + '\\n');
if (a[0] === 'pr' && a[1] === 'view') {
  // No PR for the branch unless the test says one is open.
  if (!process.env.FAKE_GH_OPEN_PR) { console.error('no pull requests found for branch'); process.exit(1); }
  console.log(JSON.stringify({ url: process.env.FAKE_GH_OPEN_PR, state: 'OPEN' }));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'edit') process.exit(0);
console.log('https://github.com/CrankHub/example/pull/7');
`;
const ghCalls = (file, verb) => lines(file).filter((c) => c[0] === 'pr' && c[1] === verb);

const FAKE_HOOKS = `
import { appendFileSync } from 'node:fs';
appendFileSync(process.env.FAKE_HOOKS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
`;

// Behaves like evaluator/evaluate.mjs at its seams: no issue text is exit 2; no test-results file
// in <repo>/.harness/runs/<KEY>/ is NEEDS_WORK; the verdict is written in the real shape.
const FAKE_EVALUATOR = `
import { writeFileSync, mkdirSync, existsSync, readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
const a = process.argv.slice(2);
const arg = (n) => (a.includes(n) ? a[a.indexOf(n) + 1] : undefined);
appendFileSync(process.env.FAKE_EVAL_LOG, JSON.stringify(a) + '\\n');
const runs = readFileSync(process.env.FAKE_EVAL_LOG, 'utf8').trim().split('\\n').length;
const dir = join(arg('--repo'), '.harness', 'runs', arg('--issue'));
const issuePath = arg('--issue-file') || join(dir, 'issue.md');
if (!existsSync(issuePath)) { console.error('no issue text: ' + issuePath + ' does not exist'); process.exit(2); }
const results = join(dir, 'test-results.txt');
const haveResults = existsSync(results) && /exit 0/.test(readFileSync(results, 'utf8'));
const pass = haveResults && (process.env.FAKE_EVAL === 'pass' || (process.env.FAKE_EVAL === 'needs-work-once' && runs > 1));
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'evaluation.json'), JSON.stringify({
  verdict: pass ? 'PASS' : 'NEEDS_WORK',
  criteria: [
    { id: 'AC1', text: 'the file says ok', met: true, evidence: 'result.txt' },
    { id: 'AC2', text: 'criterion 2', met: pass, evidence: pass ? 'tested' : 'criterion 2 unproven' },
    { id: 'test-results', text: 'the tests ran and passed', met: haveResults, evidence: haveResults ? 'test-results.txt' : 'no test-results file' },
  ],
  remediation: pass ? [] : ['add a test for criterion 2'],
  notes: pass ? 'fine' : 'criterion 2 unproven',
}));
process.exit(pass ? 0 : 1);
`;

const ISSUE = `# ${KEY}: Write the result file

Labels: Feature, agent-ready, size:S

## Goal

A file that says ok.

## Touches

\`result.txt\`, \`docs/\`
`;

function scratch({ hooks = false, evaluator = false, contract = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'crankharness-dispatch-'));
  // The harness, copied.
  const harness = join(dir, 'harness');
  mkdirSync(join(harness, 'dispatch'), { recursive: true });
  copyFileSync(join(ROOT, 'dispatch', 'dispatch.mjs'), join(harness, 'dispatch', 'dispatch.mjs'));
  copyFileSync(join(ROOT, 'check-contract.mjs'), join(harness, 'check-contract.mjs'));
  writeFileSync(join(harness, 'package.json'), '{ "type": "module" }\n');
  if (hooks) {
    mkdirSync(join(harness, 'hooks'));
    writeFileSync(join(harness, 'hooks', 'install.mjs'), FAKE_HOOKS);
  }
  if (evaluator) {
    mkdirSync(join(harness, 'evaluator'));
    writeFileSync(join(harness, 'evaluator', 'evaluate.mjs'), FAKE_EVALUATOR);
  }
  // The fakes.
  const fakes = join(dir, 'fakes');
  mkdirSync(fakes);
  writeFileSync(join(fakes, 'package.json'), '{ "type": "module" }\n');
  writeFileSync(join(fakes, 'worker.mjs'), FAKE_WORKER);
  writeFileSync(join(fakes, 'gh.mjs'), FAKE_GH);
  // The project: a bare origin and a checkout of it.
  const origin = join(dir, 'origin.git');
  sh('git', ['init', '-q', '--bare', '-b', 'main', origin], dir);
  const repo = join(dir, 'project');
  sh('git', ['init', '-q', '-b', 'main', repo], dir);
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), '# project\n');
  if (contract) {
    writeFileSync(join(repo, 'AGENTS.md'), ['# Rules', '## Mission', '## Scope rules', '## Phase permissions', '## Stop conditions', '## For Rob to confirm', '## Done', ''].join('\n'));
    writeFileSync(join(repo, 'CLAUDE.md'), 'Read AGENTS.md.\n');
    writeFileSync(join(repo, 'WORKFLOW.md'), [
      '---', 'harness: crankharness', 'contract: 1', 'project: CrankHub/example',
      'tracker:', '  kind: linear', '  team: TST', '  ready_label: agent-ready',
      '  states:', '    todo: Todo', '    in_progress: In Progress', '    blocked: Blocked', '    done: Done',
      'concurrency: 3', 'branch:', '  pattern: agent/<ISSUE-ID>-<slug>', 'gate:', '  local: tools/gate.sh',
      'touches:', '  default: lane', 'verify:', '  skill: .claude/skills/verify/SKILL.md',
      '  feature_map: .claude/skills/verify/feature-map.md', '  pending: TST-1',
      'caps:', '  cycles: 8', '  same_failure: 3', '  turns: 80', '  wall_minutes: 10', '---', '', '# prose', '',
    ].join('\n'));
    mkdirSync(join(repo, 'tools'));
    writeFileSync(join(repo, 'tools', 'gate.sh'), '#!/usr/bin/env bash\nif grep -q ok result.txt 2>/dev/null; then echo "  ok    result"; exit 0; fi\necho "  FAIL  result.txt does not say ok"; exit 1\n');
  }
  git(repo, 'add', '-A');
  if (contract) {
    // Executable on disk and in the index, so the checkout is clean where file modes count (Linux).
    chmodSync(join(repo, 'tools', 'gate.sh'), 0o755);
    git(repo, 'add', '--chmod=+x', 'tools/gate.sh');
  }
  git(repo, 'commit', '-q', '-m', 'start');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  git(repo, 'remote', 'set-head', 'origin', 'main');
  const issueFile = join(dir, `${KEY}.md`);
  writeFileSync(issueFile, ISSUE);
  const logs = { gh: join(dir, 'gh.log'), hooks: join(dir, 'hooks.log'), evaluator: join(dir, 'eval.log') };
  return { dir, harness, repo, origin, issueFile, fakes, logs };
}

function dispatch(s, extra = [], env = {}) {
  const args = [
    join(s.harness, 'dispatch', 'dispatch.mjs'),
    '--repo', s.repo, '--issue', KEY, '--issue-file', s.issueFile,
    '--worker-cmd', JSON.stringify([process.execPath, join(s.fakes, 'worker.mjs')]),
    '--gh-cmd', JSON.stringify([process.execPath, join(s.fakes, 'gh.mjs')]),
    ...extra,
  ];
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8',
    env: { ...process.env, FAKE_GH_LOG: s.logs.gh, FAKE_HOOKS_LOG: s.logs.hooks, FAKE_EVAL_LOG: s.logs.evaluator, ...env },
  });
  const recordPath = join(s.repo, '.harness', 'runs', KEY, 'dispatch.json');
  const record = existsSync(recordPath) ? JSON.parse(readFileSync(recordPath, 'utf8')) : null;
  return { code: r.status, out: r.stdout + r.stderr, record };
}

const lines = (file) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const BRANCH = `agent/${KEY}-write-the-result-file`;

// --- the small parts --------------------------------------------------------------------------

test('slugify keeps whole words within 40 characters', () => {
  assert.equal(slugify('Foundation: harvest the engine, room, pilots and card definitions'), 'foundation-harvest-the-engine-room');
  assert.equal(slugify(null), '');
});

test('branchName fills the pattern and drops a dangling dash when there is no slug', () => {
  assert.equal(branchName('agent/<ISSUE-ID>-<slug>', 'CMD-21', 'harvest'), 'agent/CMD-21-harvest');
  assert.equal(branchName('agent/<ISSUE-ID>-<slug>', 'CMD-21', ''), 'agent/CMD-21');
});

test('touchesGlobs turns a folder into folder/** and falls back to touches.default', () => {
  assert.equal(touchesGlobs(['tools/harvest', 'engine/'], 'lane'), 'tools/harvest,engine/**');
  assert.equal(touchesGlobs([], 'lane'), 'lane');
});

test('readIssue takes the title, the labels and the Touches from the issue file', () => {
  const s = scratch({ contract: false });
  const issue = readIssue(KEY, s.issueFile);
  assert.equal(issue.title, 'Write the result file');
  assert.deepEqual(issue.labels, ['Feature', 'agent-ready', 'size:S']);
  assert.deepEqual(issue.touches, ['result.txt', 'docs/']);
  rmSync(s.dir, { recursive: true, force: true });
});

test('the same failure is the same whatever the timings say (CMD-21, dispatch 1)', () => {
  const run = (a, b, c) => [
    '4. Secrets and personal addresses in text',
    '  FAIL  possible secret:',
    '        engine/HARVEST.json:59400:   "path": "game/engine/cards/u/urabrask-the-hidden.json",',
    'ok 2 - Krenko Goblins against itself plays to a result',
    `  duration_ms: ${a}`,
    `# duration_ms ${b}`,
    `took ${c}s, 12 ms per game`,
    '# tests 3',
    'FAIL',
  ].join('\n');
  assert.equal(failureSignature('gate', run('1108.2951', '2339.2793', '9.6')), failureSignature('gate', run('1284.5904', '2665.119', '10.5')));
  // A different failure is still different.
  assert.notEqual(failureSignature('gate', run('1', '2', '3')), failureSignature('gate', run('1', '2', '3').replace('# tests 3', '# tests 4')));
});

test('parseCommand takes a JSON array or words', () => {
  assert.deepEqual(parseCommand('["node", "a b.mjs"]'), ['node', 'a b.mjs']);
  assert.deepEqual(parseCommand('node "a b.mjs" --x'), ['node', 'a b.mjs', '--x']);
});

test('parseArgs refuses a bad key, an unknown provider and a missing repo', () => {
  assert.throws(() => parseArgs(['--repo', '.', '--issue', 'cmd21']), /not an issue key/);
  assert.throws(() => parseArgs(['--repo', '.', '--issue', 'CMD-21', '--provider', 'gemini']), /one of/);
  assert.throws(() => parseArgs(['--repo', '.', '--issue', 'CMD-21', '--evaluator', 'grok']), /--evaluator grok/);
  assert.throws(() => parseArgs(['--issue', 'CMD-21']), /--repo/);
  assert.equal(parseArgs(['--repo', '.', '--issue', 'CMD-21', '--dry-run']).dryRun, true);
});

test('"gpt", the name a project uses, runs the Codex worker (ROB-407, dispatch 2)', () => {
  const o = parseArgs(['--repo', '.', '--issue', 'CMD-62', '--provider', 'gpt']);
  assert.equal(o.provider, 'codex');
  assert.equal(o.providerAsNamed, 'gpt');
  assert.equal(parseArgs(['--repo', '.', '--issue', 'CMD-62', '--evaluator', 'gpt']).evaluator, 'codex');
});

test('parseFlow reads the YAML flow values WORKFLOW.md uses', () => {
  assert.deepEqual(parseFlow('{claude: [gpt, grok], gpt: [claude, grok]}'), { claude: ['gpt', 'grok'], gpt: ['claude', 'grok'] });
  assert.deepEqual(parseFlow('{share: 1, tiers: {A: claude-fable-5-2, B: unset}}'), { share: '1', tiers: { A: 'claude-fable-5-2', B: 'unset' } });
  assert.equal(parseFlow('plain'), 'plain');
});

test('the evaluator is another provider when WORKFLOW.md names one (follow-up F)', () => {
  const providers = { evaluate: '{claude: [gpt, grok], gpt: [claude, grok], grok: [gpt, claude]}' };
  assert.equal(chooseEvaluator({ providers, worker: 'codex', workerAsNamed: 'gpt' }).provider, 'claude');
  assert.equal(chooseEvaluator({ providers, worker: 'claude', workerAsNamed: 'claude' }).provider, 'codex');
  assert.equal(chooseEvaluator({ providers, worker: 'grok', workerAsNamed: 'grok' }).provider, 'codex');
  // Named under the harness's own name, too.
  assert.equal(chooseEvaluator({ providers, worker: 'codex', workerAsNamed: 'codex' }).provider, 'claude');
  // Nothing named: the worker's own provider, and the record says why.
  const own = chooseEvaluator({ providers: undefined, worker: 'claude', workerAsNamed: 'claude' });
  assert.equal(own.provider, 'claude');
  assert.match(own.why, /names no evaluator/);
  // Only grok listed (not runnable yet): the worker's own.
  assert.equal(chooseEvaluator({ providers: { evaluate: '{claude: [grok]}' }, worker: 'claude', workerAsNamed: 'claude' }).provider, 'claude');
  assert.equal(chooseEvaluator({ providers, worker: 'claude', workerAsNamed: 'claude', override: 'claude' }).provider, 'claude');
});

test('readWorkerOutput reads codex exec --json events and claude -p JSON', () => {
  const codex = [
    '{"type":"thread.started","thread_id":"t-1"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"command_execution","command":"ls"}}',
    '{"type":"item.completed","item":{"id":"item_1","type":"agent_message","text":"first"}}',
    '{"type":"item.completed","item":{"id":"item_2","type":"agent_message","text":"done: three candidates"}}',
    '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":5}}',
  ].join('\n');
  const c = readWorkerOutput('codex', codex);
  assert.equal(c.summary, 'done: three candidates');
  assert.equal(c.turns, 1);
  assert.equal(c.steps, 3);
  assert.equal(c.session_id, 't-1');
  assert.deepEqual(c.usage, { input_tokens: 100, output_tokens: 5 });
  const cl = readWorkerOutput('claude', JSON.stringify({ result: 'ok', num_turns: 4, session_id: 's' }));
  assert.equal(cl.summary, 'ok');
  assert.equal(cl.turns, 4);
  assert.deepEqual(readWorkerOutput('codex', 'not json'), {});
});

test('the worker seam: claude -p first, codex exec behind it, grok pending', () => {
  const c = workerCommand('claude', { model: 'claude-sonnet-5-5' });
  assert.deepEqual(c.argv.slice(0, 4), ['claude', '-p', '--output-format', 'json']);
  assert.ok(c.argv.includes('--allowedTools'));
  assert.ok(c.argv.includes('claude-sonnet-5-5'));
  assert.ok(workerCommand('codex').argv.includes('exec'));
  assert.match(workerCommand('grok').pending, /grok worker pending/);
  assert.deepEqual(workerCommand('grok', { override: 'node w.mjs' }).argv, ['node', 'w.mjs']);
});

// --- the whole run ------------------------------------------------------------------------------

test('--dry-run passes the contract, prints the plan and creates nothing', () => {
  const s = scratch();
  const r = dispatch(s, ['--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /contract\s+PASS \(1 pending\)/);
  assert.match(r.out, new RegExp(`branch\\s+${BRANCH} from origin/main`));
  assert.match(r.out, /hooks pending/);
  assert.match(r.out, /evaluator pending/);
  assert.match(r.out, /touches\s+result\.txt,docs\/\*\*/);
  assert.match(r.out, /dry run: nothing was created, run or pushed/);
  assert.equal(existsSync(join(s.repo, '.harness')), false);
  assert.equal(git(s.repo, 'branch', '--list', 'agent/*'), '');
  assert.equal(lines(s.logs.gh).length, 0);
  rmSync(s.dir, { recursive: true, force: true });
});

test('a repository that fails the contract is refused, and nothing is created', () => {
  const s = scratch({ contract: false });
  const r = dispatch(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /FAIL: \d+ missing/);
  assert.match(r.out, /REFUSED\s+the repository fails the contract/);
  assert.equal(existsSync(join(s.repo, '.harness')), false);
  rmSync(s.dir, { recursive: true, force: true });
});

test('an issue without agent-ready is refused', () => {
  const s = scratch();
  writeFileSync(s.issueFile, ISSUE.replace('agent-ready, ', ''));
  const r = dispatch(s);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /is not labeled agent-ready/);
  assert.equal(existsSync(join(s.repo, '.harness')), false);
  rmSync(s.dir, { recursive: true, force: true });
});

test('a real dispatch without --issue-file is refused; grok without a command is refused', () => {
  const s = scratch();
  const noFile = spawnSync(process.execPath, [join(s.harness, 'dispatch', 'dispatch.mjs'), '--repo', s.repo, '--issue', KEY], { encoding: 'utf8' });
  assert.equal(noFile.status, 1);
  assert.match(noFile.stdout, /no --issue-file/);
  const grok = spawnSync(process.execPath, [join(s.harness, 'dispatch', 'dispatch.mjs'), '--repo', s.repo, '--issue', KEY, '--issue-file', s.issueFile, '--provider', 'grok'], { encoding: 'utf8' });
  assert.equal(grok.status, 1);
  assert.match(grok.stdout, /grok worker pending/);
  rmSync(s.dir, { recursive: true, force: true });
});

test('one issue to one draft PR, with hooks and evaluator pending', () => {
  const s = scratch();
  const r = dispatch(s);
  assert.equal(r.code, 0, r.out);
  const rec = r.record;
  assert.equal(rec.final_state, 'draft-pr');
  assert.equal(rec.branch, BRANCH);
  assert.equal(rec.hooks, 'hooks pending');
  assert.equal(rec.evaluator, 'evaluator pending');
  assert.equal(rec.first_pass_gate, true);
  assert.equal(rec.first_pass_pass, null);
  assert.equal(rec.human_interventions, 0);
  assert.equal(rec.cycles.length, 1);
  assert.equal(rec.cycles[0].worker.turns, 4);
  assert.equal(rec.turns, 4);
  assert.equal(rec.pr.url, 'https://github.com/CrankHub/example/pull/7');
  assert.equal(rec.pushed, true);
  assert.match(rec.next[0], /comment the PR link on TST-7/);
  // The branch is on origin and carries the worker's commit.
  assert.match(git(s.origin, 'log', '--oneline', BRANCH), /TST-7: cycle 1/);
  // The draft PR was asked for with the key in the title.
  const [gh] = ghCalls(s.logs.gh, 'create');
  assert.deepEqual(gh.slice(0, 7), ['pr', 'create', '--draft', '--base', 'main', '--head', BRANCH]);
  assert.equal(r.record.pr.reused, false);
  assert.equal(gh[gh.indexOf('--title') + 1], 'TST-7: Write the result file');
  // The run folder.
  const run = join(s.repo, '.harness', 'runs', KEY);
  for (const f of ['prompt.md', 'worker-1.out.json', 'gate-1.txt', 'pr-body.md', 'diff.patch', 'PROGRESS.md']) {
    assert.ok(existsSync(join(run, f)), `${f} is in the run folder`);
  }
  assert.match(readFileSync(join(run, 'prompt.md'), 'utf8'), /# TST-7: Write the result file/);
  assert.match(readFileSync(join(run, 'pr-body.md'), 'utf8'), /not yet provable \(evaluator pending, ROB-406\)/);
  // .harness/ is excluded through .git/info/exclude, never the project's .gitignore.
  assert.match(readFileSync(join(s.repo, '.git', 'info', 'exclude'), 'utf8'), /^\.harness\/$/m);
  assert.equal(existsSync(join(s.repo, '.gitignore')), false);
  assert.equal(git(s.repo, 'status', '--porcelain'), '');
  rmSync(s.dir, { recursive: true, force: true });
});

test('work the worker left uncommitted is committed by dispatch and said so', () => {
  const s = scratch();
  const r = dispatch(s, [], { FAKE_MODE: 'leave' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.record.cycles[0].committed_by_dispatch, true);
  assert.match(git(s.origin, 'log', '--oneline', BRANCH), /committed by dispatch/);
  rmSync(s.dir, { recursive: true, force: true });
});

test('a gate failure goes back to the worker with the gate output, then passes', () => {
  const s = scratch();
  const r = dispatch(s, [], { FAKE_MODE: 'bad-then-good' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.record.cycles.length, 2);
  assert.equal(r.record.cycles[0].gate.exit, 1);
  assert.equal(r.record.first_pass_gate, false);
  const prompt2 = readFileSync(join(s.repo, '.harness', 'runs', KEY, 'prompt-2.md'), 'utf8');
  assert.match(prompt2, /The local gate `tools\/gate.sh` exited 1/);
  assert.match(prompt2, /result.txt does not say ok/);
  rmSync(s.dir, { recursive: true, force: true });
});

test('the same failure three times stops the run: no push, no PR, a Blocked note', () => {
  const s = scratch();
  const r = dispatch(s, [], { FAKE_MODE: 'always-bad' });
  assert.equal(r.code, 1, r.out);
  assert.equal(r.record.final_state, 'stopped');
  assert.equal(r.record.cycles.length, 3);
  assert.match(r.record.stop, /the same failure 3 times/);
  assert.equal(r.record.pushed, false);
  assert.equal(r.record.pr, null);
  assert.match(r.record.next[0], /move TST-7 to Blocked/);
  assert.equal(lines(s.logs.gh).length, 0);
  assert.equal(spawnSync('git', ['rev-parse', '--verify', '--quiet', BRANCH], { cwd: s.origin }).status, 1);
  rmSync(s.dir, { recursive: true, force: true });
});

test('a worker that changes nothing, or fails, stops the run', () => {
  const s = scratch();
  const none = dispatch(s, [], { FAKE_MODE: 'nothing' });
  assert.equal(none.code, 1, none.out);
  assert.match(none.record.stop, /made no change/);
  const crash = dispatch(s, [], { FAKE_MODE: 'crash' });
  assert.equal(crash.code, 1, crash.out);
  assert.match(crash.record.stop, /the worker exited 3: usage limit reached/);
  assert.equal(crash.record.worktree_state, 'resumed');
  rmSync(s.dir, { recursive: true, force: true });
});

test('a retry resumes the same worktree and branch, merging main in', () => {
  const s = scratch();
  assert.equal(dispatch(s, [], { FAKE_MODE: 'crash' }).code, 1);
  // main moves on meanwhile.
  writeFileSync(join(s.repo, 'NOTES.md'), 'main moved\n');
  git(s.repo, 'add', 'NOTES.md');
  git(s.repo, 'commit', '-q', '-m', 'main moves');
  git(s.repo, 'push', '-q', 'origin', 'main');
  const r = dispatch(s);
  assert.equal(r.code, 0, r.out);
  assert.equal(r.record.worktree_state, 'resumed');
  const wt = join(s.repo, '.harness', 'worktrees', KEY);
  assert.ok(existsSync(join(wt, 'NOTES.md')), 'main was merged in');
  assert.equal(git(wt, 'rev-list', '--merges', '--count', 'origin/main..HEAD'), '0'); // fast-forward: no work yet
  rmSync(s.dir, { recursive: true, force: true });
});

test('with hooks and an evaluator: hooks get the Touches; NEEDS_WORK goes back to the worker', () => {
  const s = scratch({ hooks: true, evaluator: true });
  const r = dispatch(s, [], { FAKE_EVAL: 'needs-work-once' });
  assert.equal(r.code, 0, r.out);
  const rec = r.record;
  assert.equal(rec.hooks, 'installed');
  assert.equal(rec.evaluator, 'ran');
  assert.deepEqual(rec.cycles.map((c) => c.evaluation.verdict), ['NEEDS_WORK', 'PASS']);
  assert.equal(rec.first_pass_gate, true);
  assert.equal(rec.first_pass_pass, false);
  const wt = join(s.repo, '.harness', 'worktrees', KEY);
  assert.deepEqual(lines(s.logs.hooks)[0], ['--worktree', wt, '--phase', 'implement', '--touches', 'result.txt,docs/**']);
  assert.deepEqual(lines(s.logs.evaluator)[0], ['--repo', wt, '--issue', KEY, '--branch', BRANCH, '--provider', 'claude', '--issue-file', resolve(s.issueFile)]);
  // The evaluator's evidence sits where it looks: the gate output as test-results.txt in the worktree's run folder.
  assert.match(readFileSync(join(wt, '.harness', 'runs', KEY, 'test-results.txt'), 'utf8'), /exit 0/);
  const run = join(s.repo, '.harness', 'runs', KEY);
  assert.equal(JSON.parse(readFileSync(join(run, 'evaluation.json'), 'utf8')).verdict, 'NEEDS_WORK');
  assert.equal(JSON.parse(readFileSync(join(run, 'evaluation-2.json'), 'utf8')).verdict, 'PASS');
  const prompt2 = readFileSync(join(run, 'prompt-2.md'), 'utf8');
  assert.match(prompt2, /add a test for criterion 2/);
  assert.match(prompt2, /"AC2"/); // the unmet criterion goes back to the worker, not just a summary
  assert.doesNotMatch(prompt2, /"AC1"/); // met criteria do not
  rmSync(s.dir, { recursive: true, force: true });
});

test('a branch that already has an open PR reuses it: its body is replaced, no second PR (CMD-21, dispatch 1)', () => {
  const s = scratch();
  const open = 'https://github.com/CrankHub/example/pull/15';
  const r = dispatch(s, [], { FAKE_GH_OPEN_PR: open });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.record.pr.url, open);
  assert.equal(r.record.pr.reused, true);
  assert.equal(ghCalls(s.logs.gh, 'create').length, 0);
  const [edit] = ghCalls(s.logs.gh, 'edit');
  assert.deepEqual(edit.slice(0, 4), ['pr', 'edit', BRANCH, '--body-file']);
  rmSync(s.dir, { recursive: true, force: true });
});

test('a change of thousands of files still gets a PR body GitHub accepts (CMD-21, dispatch 1)', () => {
  const s = scratch();
  const r = dispatch(s, [], { FAKE_MODE: 'many' });
  assert.equal(r.code, 0, r.out);
  const body = readFileSync(join(s.repo, '.harness', 'runs', KEY, 'pr-body.md'), 'utf8');
  assert.ok(body.length < 65536, `the body is ${body.length} characters; GitHub's limit is 65,536`);
  assert.match(body, /3001 files changed/); // the summary line survives the cap
  assert.ok(body.split('\n').filter((l) => l.includes('a-card-with-a-rather-long-file-name')).length <= 40);
  assert.doesNotMatch(body, /[A-Za-z]:[\\/]Users[\\/]|\/tmp\//); // no machine path in the body
  rmSync(s.dir, { recursive: true, force: true });
});

test('first-pass PASS: the gate and the evaluator both pass on cycle 1', () => {
  const s = scratch({ hooks: true, evaluator: true });
  const r = dispatch(s, [], { FAKE_EVAL: 'pass' });
  assert.equal(r.code, 0, r.out);
  assert.equal(r.record.first_pass_pass, true);
  assert.equal(r.record.cycles.length, 1);
  assert.match(readFileSync(join(s.repo, '.harness', 'runs', KEY, 'pr-body.md'), 'utf8'), /returned PASS/);
  rmSync(s.dir, { recursive: true, force: true });
});
