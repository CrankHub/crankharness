// hooks/stop.mjs: the session ends only when the gate passes or a cap is hit; on a pass the
// task-owned files, and only those, are committed.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { repo, run as install, workflow } from './hooks-fixtures.test.mjs';

const STOP = resolve(import.meta.dirname, '..', 'hooks', 'stop.mjs');

function setup({ gateLocal = 'test ! -e BROKEN', gateStop = null, phase = 'implement', touches = 'src/**', cycles } = {}) {
  let wf = workflow({ gateLocal, gateStop });
  if (cycles) wf = wf.replace('cycles: 8', `cycles: ${cycles}`);
  const root = repo({ 'WORKFLOW.md': wf, 'src/app.js': 'one\n', 'src/app.test.js': 'test\n' });
  const args = ['--worktree', root, '--phase', phase];
  if (touches) args.push('--touches', touches);
  const r = install(args);
  assert.equal(r.status, 0, r.stderr);
  const settings = JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
  const configPath = /"([^"]+hooks\.json)"/.exec(settings.hooks.Stop[0].hooks[0].command)[1];
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  return { root, configPath, config };
}

function stop(env, input = { hook_event_name: 'Stop', stop_hook_active: false }) {
  return spawnSync(process.execPath, [STOP, env.configPath], { input: JSON.stringify(input), encoding: 'utf8' });
}

const git = (root, ...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();
const state = (env) => JSON.parse(readFileSync(env.config.state_path, 'utf8'));
const lastLog = (env) => JSON.parse(readFileSync(env.config.log_path, 'utf8').trim().split('\n').at(-1));

describe('the gate fails: the stop is refused with the diagnostics', () => {
  test('exit 2, the command and its output on stderr, the attempt counted', () => {
    const env = setup({ gateLocal: 'echo "lint: 2 problems in src/app.js"; test ! -e BROKEN' });
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'BROKEN'), '');
    const r = stop(env);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /the gate failed \(attempt 1 of 8\)/);
    assert.match(r.stderr, /lint: 2 problems in src\/app\.js/);
    assert.equal(state(env).attempts, 1);
    assert.equal(lastLog(env).result, 'blocked');
    assert.equal(git(env.root, 'log', '--oneline').split('\n').length, 1, 'nothing is committed on a failure');
  });

  test('the same failure caps.same_failure times: the stop is allowed and handed to the evaluator', () => {
    const env = setup();
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'BROKEN'), '');
    assert.equal(stop(env).status, 2);
    assert.equal(stop(env, { stop_hook_active: true }).status, 2);
    const third = stop(env, { stop_hook_active: true });
    assert.equal(third.status, 0);
    assert.match(JSON.parse(third.stdout).systemMessage, /same way 3 times.*evaluator/);
    assert.match(state(env).handoff.why, /same way 3 times/);
    assert.equal(lastLog(env).result, 'handoff');
  });

  test('caps.cycles different failures: the stop is allowed', () => {
    const env = setup({ gateLocal: 'cat BROKEN; exit 1', cycles: 2 });
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'BROKEN'), 'first');
    assert.equal(stop(env).status, 2);
    writeFileSync(join(env.root, 'BROKEN'), 'second');
    const r = stop(env, { stop_hook_active: true });
    assert.equal(r.status, 0);
    assert.match(state(env).handoff.why, /failed 2 times \(cap 2\)/);
  });
});

describe('the gate passes: the stop is allowed', () => {
  test('only the task-owned files are committed', () => {
    const env = setup();
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'src', 'new.js'), 'new\n');
    writeFileSync(join(env.root, 'notes.txt'), 'not in Touches\n');
    const r = stop(env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(git(env.root, 'log', '-1', '--format=%s'), "ROB-9: the task's files, committed after the gate passed (CrankHarness Stop hook)");
    assert.deepEqual(git(env.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort(), ['src/app.js', 'src/new.js']);
    assert.equal(git(env.root, 'status', '--porcelain'), '?? notes.txt');
    const log = lastLog(env);
    assert.equal(log.result, 'passed');
    assert.deepEqual(log.left_uncommitted, ['notes.txt']);
  });

  test('a pass after failures resets the counters', () => {
    const env = setup();
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'BROKEN'), '');
    assert.equal(stop(env).status, 2);
    rmSync(join(env.root, 'BROKEN'));
    assert.equal(stop(env, { stop_hook_active: true }).status, 0);
    assert.equal(state(env).attempts, 0);
  });

  test('<ref> is HEAD plus the uncommitted task files: what would be committed', () => {
    const env = setup({ gateLocal: 'git cat-file -e <ref>:src/new.js && ! git cat-file -e <ref>:notes.txt' });
    writeFileSync(join(env.root, 'src', 'new.js'), 'new\n');
    writeFileSync(join(env.root, 'notes.txt'), 'outside\n');
    const r = stop(env);
    assert.equal(r.status, 0, r.stderr);
  });

  test('gate.stop runs first: lint, typecheck, the touched tests; <tests> names them', () => {
    const env = setup({ gateStop: ['echo lint', 'echo tests: <tests> > tests-ran.txt'], gateLocal: 'exit 0' });
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    const r = stop(env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(readFileSync(join(env.root, 'tests-ran.txt'), 'utf8'), /tests: src\/app\.test\.js/);
    assert.deepEqual(lastLog(env).ran.map((x) => x.exit), [0, 0, 0]);
  });

  test('a command whose <tests> is empty is skipped, not run', () => {
    const env = setup({ gateStop: ['node --test <tests>'], gateLocal: 'exit 0', touches: 'docs/**' });
    mkdirSync(join(env.root, 'docs'));
    writeFileSync(join(env.root, 'docs', 'guide.md'), 'x\n');
    assert.equal(stop(env).status, 0);
    assert.equal(lastLog(env).ran[0].skipped, 'no touched tests');
  });

  test('nothing changed: nothing to check', () => {
    const env = setup({ gateLocal: 'exit 1' });
    assert.equal(stop(env).status, 0);
    assert.equal(lastLog(env).why, 'nothing changed');
  });
});

describe('per phase', () => {
  test('evaluate: no gate, the stop is allowed', () => {
    const env = setup({ phase: 'evaluate', gateLocal: 'exit 1', touches: null });
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    assert.equal(stop(env).status, 0);
  });
  test('merge: the gate runs, nothing is committed', () => {
    const env = setup({ phase: 'merge', touches: null });
    writeFileSync(join(env.root, 'src', 'app.js'), 'two\n');
    writeFileSync(join(env.root, 'BROKEN'), '');
    assert.equal(stop(env).status, 2);
    rmSync(join(env.root, 'BROKEN'));
    assert.equal(stop(env).status, 0);
    assert.equal(git(env.root, 'log', '--oneline').split('\n').length, 1);
  });
});
