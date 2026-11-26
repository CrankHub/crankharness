// The evaluator's tests. They use a fake worker (CRANKHARNESS_EVALUATOR_CMD) and never call a real model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowedOutsideTouches, decide, extractJson, globToRegExp, outsideTouches, outsideTouchesAllowing, parseIssue, touchPaths } from '../evaluator/evaluate.mjs';

const EVALUATE = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'evaluator', 'evaluate.mjs');

const ISSUE = `# Add a greeting

## Goal

The app greets the user by name.

## Acceptance criteria

- [ ] WHEN the user gives a name THE SYSTEM SHALL return "Hello, <name>".
- [ ] WHEN no name is given THE SYSTEM SHALL return "Hello, friend".

## Touches

- \`src/**\` (edit)
- tests/greet.test.js (new)

## Out of scope

- Translations.
`;

function sh(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function write(root, rel, content) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), content);
}

// A repository with main and a feature branch. files: the branch's changes. Leaves main checked out.
function repo({ files = { 'src/greet.js': 'export const greet = (n) => `Hello, ${n ?? "friend"}`;\n', 'tests/greet.test.js': 'test("greets", () => {});\n' }, issue = ISSUE, testResults = '# tests 2\n# pass 2\n# fail 0\n', workflow = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crankharness-eval-test-'));
  sh(root, 'init', '-q', '-b', 'main');
  write(root, 'README.md', '# example\n');
  if (workflow) for (const [rel, content] of Object.entries(workflow)) write(root, rel, content);
  sh(root, 'add', '-A');
  sh(root, 'commit', '-q', '-m', 'base');
  sh(root, 'checkout', '-q', '-b', 'agent/EX-1-greet');
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  if (Object.keys(files).length) {
    sh(root, 'add', '-A');
    sh(root, 'commit', '-q', '-m', 'greet');
  }
  sh(root, 'checkout', '-q', 'main');
  const run = join(root, '.harness', 'runs', 'EX-1');
  mkdirSync(run, { recursive: true });
  if (issue !== null) writeFileSync(join(root, 'issue.md'), issue);
  if (testResults !== null) writeFileSync(join(run, 'test-results.txt'), testResults);
  return root;
}

// The fake worker: records the prompt and its folder, then prints FAKE_REPLY.
function fakeWorker(dir) {
  const path = join(dir, 'fake-worker.mjs');
  writeFileSync(path, [
    "import { readFileSync, writeFileSync } from 'node:fs';",
    "const prompt = readFileSync(0, 'utf8');",
    "if (process.env.FAKE_LOG) writeFileSync(process.env.FAKE_LOG, JSON.stringify({ cwd: process.cwd(), prompt }));",
    "if (process.env.FAKE_FAIL) { process.stderr.write('model unavailable'); process.exit(3); }",
    "process.stdout.write(process.env.FAKE_REPLY || '');",
  ].join('\n'));
  return path;
}

function evaluate(root, { reply, args = [], env = {} } = {}) {
  const worker = fakeWorker(root);
  const log = join(root, 'fake-log.json');
  const r = spawnSync(process.execPath, [EVALUATE, '--repo', root, '--issue', 'EX-1', '--branch', 'agent/EX-1-greet', '--issue-file', join(root, 'issue.md'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      CRANKHARNESS_EVALUATOR_CMD: `"${process.execPath}" "${worker}"`,
      FAKE_LOG: log,
      FAKE_REPLY: typeof reply === 'string' ? reply : `Here is my verdict.\n\n\`\`\`json\n${JSON.stringify(reply)}\n\`\`\`\n`,
      ...env,
    },
  });
  const out = join(root, '.harness', 'runs', 'EX-1', 'evaluation.json');
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    evaluation: existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null,
    seen: existsSync(log) ? JSON.parse(readFileSync(log, 'utf8')) : null,
  };
}

const ALL_MET = {
  verdict: 'PASS',
  criteria: [
    { id: 'AC1', met: true, evidence: 'src/greet.js line 1; test "greets"' },
    { id: 'AC2', met: true, evidence: 'the default "friend"' },
    { id: 'test-results', met: true, evidence: '# pass 2, # fail 0' },
    { id: 'verification-gap', met: true, evidence: 'the tests assert the output' },
    { id: 'touches', met: true, evidence: 'inside' },
  ],
  remediation: [],
  notes: 'It does what the issue asks.',
};

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// --- the command line, end to end, with a fake worker --------------------------------------------------------

test('PASS: every criterion met, test results present, diff inside Touches: exit 0 and evaluation.json', () => {
  const root = repo();
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 0, r.stderr);
  const e = r.evaluation;
  assert.equal(e.issue, 'EX-1');
  assert.equal(e.branch, 'agent/EX-1-greet');
  assert.equal(e.verdict, 'PASS');
  assert.match(e.provider, /claude/);
  assert.deepEqual(e.criteria.map((c) => c.id), ['AC1', 'AC2', 'test-results', 'verification-gap', 'touches']);
  for (const c of e.criteria) {
    assert.equal(typeof c.text, 'string');
    assert.equal(c.met, true);
    assert.equal(typeof c.evidence, 'string');
  }
  assert.equal(e.criteria[0].text, 'WHEN the user gives a name THE SYSTEM SHALL return "Hello, <name>".');
  assert.equal(typeof e.notes, 'string');
  assert.deepEqual(e.remediation, []);
  assert.match(r.stdout, /^PASS /m);
  cleanup(root);
});

test('the worker gets the issue, every criterion id, the diff and the test results, and runs outside the repository', () => {
  const root = repo();
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 0, r.stderr);
  const { cwd, prompt } = r.seen;
  for (const id of ['AC1', 'AC2', 'test-results', 'verification-gap', 'touches']) assert.ok(prompt.includes(`\`${id}\``), id);
  assert.ok(prompt.includes('The app greets the user by name.'));
  assert.ok(prompt.includes('+export const greet'));
  assert.ok(prompt.includes('# pass 2'));
  assert.ok(prompt.includes('default FAIL'));
  assert.ok(!resolve(cwd).toLowerCase().startsWith(resolve(root).toLowerCase()), `worker ran inside the repository: ${cwd}`);
  // The prompt and the reply are kept in the run folder for the record.
  assert.ok(existsSync(join(root, '.harness', 'runs', 'EX-1', 'evaluation.prompt.md')));
  assert.ok(existsSync(join(root, '.harness', 'runs', 'EX-1', 'evaluation.reply.txt')));
  cleanup(root);
});

test('it never changes the repository: same checkout, same branch tip, clean working tree', () => {
  const root = repo();
  const tip = sh(root, 'rev-parse', 'agent/EX-1-greet');
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(sh(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'main');
  assert.equal(sh(root, 'rev-parse', 'agent/EX-1-greet'), tip);
  const status = sh(root, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean)
    .filter((l) => !l.includes('.harness/') && !l.includes('issue.md') && !l.includes('fake-'));
  assert.deepEqual(status, []);
  cleanup(root);
});

test('NEEDS_WORK: a skipped test the worker names as a gap: exit 1, the gap and the remediation in the file', () => {
  const root = repo({ files: { 'src/greet.js': 'export const greet = (n) => `Hello, ${n}`;\n', 'tests/greet.test.js': 'test.skip("no name gives friend", () => {});\n' } });
  const r = evaluate(root, {
    reply: {
      verdict: 'NEEDS_WORK',
      criteria: [
        { id: 'AC1', met: true, evidence: 'src/greet.js' },
        { id: 'AC2', met: false, evidence: 'the only test for it is test.skip in tests/greet.test.js' },
        { id: 'test-results', met: true, evidence: '# pass 2' },
        { id: 'verification-gap', met: false, evidence: 'AC2 is covered by a skipped test' },
        { id: 'touches', met: true, evidence: 'inside' },
      ],
      remediation: ['Unskip the test in tests/greet.test.js and make it pass.'],
      notes: 'One criterion has only a skipped test.',
    },
  });
  assert.equal(r.status, 1, r.stderr);
  assert.equal(r.evaluation.verdict, 'NEEDS_WORK');
  assert.ok(r.seen.prompt.includes('test.skip'), 'the worker saw the skipped test in the diff');
  assert.equal(r.evaluation.criteria.find((c) => c.id === 'verification-gap').met, false);
  assert.deepEqual(r.evaluation.remediation, ['Unskip the test in tests/greet.test.js and make it pass.']);
  assert.match(r.stdout, /^NEEDS_WORK /m);
  cleanup(root);
});

test('default FAIL: no test-results file means NEEDS_WORK even when the worker says PASS', () => {
  const root = repo({ testResults: null });
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 1);
  const t = r.evaluation.criteria.find((c) => c.id === 'test-results');
  assert.equal(t.met, false);
  assert.match(t.evidence, /No test-results file/);
  assert.ok(r.evaluation.remediation.some((x) => /test-results\.txt/.test(x)));
  assert.match(r.evaluation.notes, /said PASS/);
  cleanup(root);
});

test('a file outside Touches is NEEDS_WORK, named, whatever the worker says', () => {
  const root = repo({ files: { 'src/greet.js': 'x\n', 'tests/greet.test.js': 'y\n', 'package.json': '{}\n' } });
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 1);
  const t = r.evaluation.criteria.find((c) => c.id === 'touches');
  assert.equal(t.met, false);
  assert.match(t.evidence, /package\.json/);
  assert.ok(r.evaluation.remediation.some((x) => /package\.json/.test(x)));
  cleanup(root);
});

test('a criterion the worker did not answer is not met (default FAIL)', () => {
  const root = repo();
  const reply = { ...ALL_MET, criteria: ALL_MET.criteria.filter((c) => c.id !== 'AC2') };
  const r = evaluate(root, { reply });
  assert.equal(r.status, 1);
  const c = r.evaluation.criteria.find((x) => x.id === 'AC2');
  assert.equal(c.met, false);
  assert.match(c.evidence, /no finding/);
  assert.ok(r.evaluation.remediation.length > 0);
  cleanup(root);
});

test('a branch with no changes is NEEDS_WORK without calling the worker', () => {
  const root = repo({ files: {} });
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 1);
  assert.equal(r.seen, null, 'the worker was called');
  assert.ok(r.evaluation.criteria.every((c) => !c.met));
  cleanup(root);
});

test('the issue text is read from the run folder when --issue-file is not given', () => {
  const root = repo();
  writeFileSync(join(root, '.harness', 'runs', 'EX-1', 'issue.md'), ISSUE);
  const worker = fakeWorker(root);
  const r = spawnSync(process.execPath, [EVALUATE, '--repo', root, '--issue', 'EX-1', '--branch', 'agent/EX-1-greet'], {
    encoding: 'utf8',
    env: { ...process.env, CRANKHARNESS_EVALUATOR_CMD: `"${process.execPath}" "${worker}"`, FAKE_REPLY: JSON.stringify(ALL_MET) },
  });
  assert.equal(r.status, 0, r.stderr);
  cleanup(root);
});

test('the project knowledge comes from the branch\'s WORKFLOW.md and verify skill', () => {
  const root = repo({
    workflow: {
      'WORKFLOW.md': '---\nharness: crankharness\nverify:\n  skill: .claude/skills/verify/SKILL.md\n  feature_map: .claude/skills/verify/feature-map.md\n---\n# Workflow prose\n',
      '.claude/skills/verify/SKILL.md': '---\nname: verify\n---\nOpen the app at /greet.\n',
    },
  });
  const r = evaluate(root, { reply: ALL_MET });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.seen.prompt.includes('# Workflow prose'));
  assert.ok(r.seen.prompt.includes('Open the app at /greet.'));
  assert.match(r.seen.prompt, /feature map: \.claude\/skills\/verify\/feature-map\.md\s+Not on the branch/);
  cleanup(root);
});

test('the previous evaluation is kept as evaluation.prev.json', () => {
  const root = repo();
  assert.equal(evaluate(root, { reply: { ...ALL_MET, verdict: 'NEEDS_WORK' } }).status, 1);
  assert.equal(evaluate(root, { reply: ALL_MET }).status, 0);
  const prev = JSON.parse(readFileSync(join(root, '.harness', 'runs', 'EX-1', 'evaluation.prev.json'), 'utf8'));
  assert.equal(prev.verdict, 'NEEDS_WORK');
  cleanup(root);
});

// --- errors: exit 2 and no verdict ----------------------------------------------------------------------------

test('errors exit 2 and write no evaluation.json', async (t) => {
  const cases = [
    ['a reply with no JSON', {}, { reply: 'I think it is fine.' }, /no JSON object/],
    ['a worker that fails', {}, { reply: ALL_MET, env: { FAKE_FAIL: '1' } }, /worker command failed.*model unavailable/],
    ['a missing branch', {}, { reply: ALL_MET, args: ['--branch', 'agent/nope'] }, /branch not found/],
    ['a missing issue file', { issue: null }, { reply: ALL_MET }, /no issue text/],
    ['an issue with no acceptance criteria', { issue: '# x\n\n## Goal\n\nSomething.\n' }, { reply: ALL_MET }, /no acceptance criteria/],
    ['an unknown flag', {}, { reply: ALL_MET, args: ['--force'] }, /Unknown option/],
    ['a missing base ref', {}, { reply: ALL_MET, args: ['--base', 'nope'] }, /base ref not found/],
  ];
  for (const [name, setup, opts, message] of cases) {
    await t.test(name, () => {
      const root = repo(setup);
      const r = evaluate(root, opts);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
      assert.equal(r.evaluation, null);
      cleanup(root);
    });
  }
});

test('unknown and unwired providers exit 2 and say why', () => {
  const root = repo();
  for (const [provider, message] of [['gemini', /unknown provider/], ['grok', /ROB-403/]]) {
    const r = spawnSync(process.execPath, [EVALUATE, '--repo', root, '--issue', 'EX-1', '--branch', 'agent/EX-1-greet', '--issue-file', join(root, 'issue.md'), '--provider', provider], {
      encoding: 'utf8',
      env: { ...process.env, CRANKHARNESS_EVALUATOR_CMD: '' },
    });
    assert.equal(r.status, 2, `${provider}: ${r.stderr}`);
    assert.match(r.stderr, message);
  }
  cleanup(root);
});

// --- the parts ------------------------------------------------------------------------------------------------

test('parseIssue reads the acceptance criteria and the Touches paths', () => {
  const { criteria, touches } = parseIssue(ISSUE);
  assert.deepEqual(criteria.map((c) => c.id), ['AC1', 'AC2']);
  assert.match(criteria[1].text, /Hello, friend/);
  assert.deepEqual(touches, ['src/**', 'tests/greet.test.js']);
});

test('parseIssue reads numbered acceptance criteria, "1." and "1)" (ROB-407, dispatch 3: CMD-86)', () => {
  const md = '# X-1: t\n\n## Acceptance criteria\n\n1. one\n2. two, with `code`\n10) ten\n\n## Touches\n\n1. `tools/qa`\n';
  const { criteria, touches } = parseIssue(md);
  assert.deepEqual(criteria.map((c) => c.text), ['one', 'two, with `code`', 'ten']);
  assert.deepEqual(criteria.map((c) => c.id), ['AC1', 'AC2', 'AC3']);
  assert.deepEqual(touches, ['tools/qa']);
  // A number inside prose is not an item.
  assert.equal(parseIssue('## Acceptance criteria\n\nIn 2026. it was so.\n').criteria.length, 0);
});

test('parseIssue reads Touches written as one line of paths, not only as a list (ROB-407, dispatches 1 and 2)', () => {
  const md = '# X-1: t\n\n## Acceptance criteria\n\n- one\n\n## Touches\n\n`tools/harvest`, `engine/`, `decks/harvested/`\n\n## Out of scope\n\nNothing.\n';
  assert.deepEqual(parseIssue(md).touches, ['tools/harvest', 'engine/', 'decks/harvested/']);
  // A list still wins, and its labels are not paths.
  assert.deepEqual(parseIssue('## Touches\n\n- `docs/look/` (edit)\n').touches, ['docs/look/']);
});

test('touchPaths takes backticked paths, or the first word that is not a label', () => {
  assert.deepEqual(touchPaths('CrankHarness: `evaluator/**` (new)'), ['evaluator/**']);
  assert.deepEqual(touchPaths('src/app.js (edit)'), ['src/app.js']);
  assert.deepEqual(touchPaths('`a/*.md`, `b/**`'), ['a/*.md', 'b/**']);
});

test('globs: ** spans folders, * stays in one, a plain path covers what is under it', () => {
  assert.ok(globToRegExp('evaluator/**').test('evaluator/evaluate.mjs'));
  assert.ok(globToRegExp('evaluator/**').test('evaluator/a/b.mjs'));
  assert.ok(globToRegExp('tests/evaluator*.test.mjs').test('tests/evaluator.test.mjs'));
  assert.ok(!globToRegExp('tests/evaluator*.test.mjs').test('tests/check-contract.test.mjs'));
  assert.ok(!globToRegExp('src/*.js').test('src/a/b.js'));
  assert.ok(globToRegExp('src').test('src/a/b.js'));
  assert.ok(globToRegExp('src/...').test('src/a/b.js'));
  // A trailing slash is the folder, as in an issue's Touches line "`engine/`" (CMD-21, dispatch 1).
  assert.ok(globToRegExp('engine/').test('engine/game/engine/aims.mjs'));
  assert.ok(globToRegExp('engine/').test('engine/HARVEST.json'));
  assert.ok(!globToRegExp('engine/').test('engines/x.mjs'));
  assert.ok(!globToRegExp('README.md').test('README.mdx'));
  assert.deepEqual(outsideTouches(['evaluator/x.mjs', 'README.md', 'package.json'], ['evaluator/**', 'README.md']), ['package.json']);
});

test('the Touches check allows what the hooks allow: for-rob/**, PROGRESS.md, new test files (CMD-21, dispatch 1)', () => {
  const allowed = allowedOutsideTouches();
  assert.ok(allowed.always.includes('for-rob/**'), 'read from hooks/rules.json');
  assert.ok(allowed.always.includes('handback/**'), "the hand-back file is the worker's too (ROB-407, dispatch 4, follow-up D)");
  const changed = [
    { status: 'A', path: 'tools/harvest' },
    { status: 'A', path: 'for-rob/CMD-21.md' },
    { status: 'A', path: 'handback/CMD-21.md' },
    { status: 'M', path: 'PROGRESS.md' },
    { status: 'A', path: 'tests/foundation/whole-game.test.mjs' },
    { status: 'M', path: 'tests/old.test.mjs' }, // an edited test is not new: still outside
    { status: 'M', path: 'AGENTS.md' },
  ];
  assert.deepEqual(outsideTouchesAllowing(changed, ['tools/harvest'], allowed), ['tests/old.test.mjs', 'AGENTS.md']);
});

test('extractJson finds the last fenced JSON block, or a bare object', () => {
  assert.deepEqual(extractJson('a\n```json\n{"verdict":"X"}\n```\nb\n```json\n{"verdict":"PASS"}\n```'), { verdict: 'PASS' });
  assert.deepEqual(extractJson('the answer is {"verdict":"NEEDS_WORK"}'), { verdict: 'NEEDS_WORK' });
  assert.equal(extractJson('no json here'), null);
});

test('decide: anything but a clean PASS with every criterion met is NEEDS_WORK', () => {
  const expected = [{ id: 'AC1', text: 'a' }, { id: 'AC2', text: 'b' }];
  const all = { verdict: 'PASS', criteria: [{ id: 'AC1', met: true, evidence: 'x' }, { id: 'AC2', met: true, evidence: 'y' }] };
  assert.equal(decide({ expected, reply: all, fixed: {} }).verdict, 'PASS');
  assert.equal(decide({ expected, reply: { ...all, verdict: 'MAYBE' }, fixed: {} }).verdict, 'NEEDS_WORK');
  assert.equal(decide({ expected, reply: { ...all, criteria: [{ id: 'AC1', met: 'yes' }, { id: 'AC2', met: true }] }, fixed: {} }).verdict, 'NEEDS_WORK');
  const forced = decide({ expected, reply: all, fixed: { AC2: { met: false, evidence: 'script says no', remediation: 'fix AC2' } } });
  assert.equal(forced.verdict, 'NEEDS_WORK');
  assert.equal(forced.criteria[1].evidence, 'script says no');
  assert.deepEqual(forced.remediation, ['fix AC2']);
  assert.ok(!('remediation' in forced.criteria[1]));
});
