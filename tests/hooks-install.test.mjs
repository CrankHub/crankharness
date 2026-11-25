// hooks/install.mjs: the interface ROB-404's dispatch script calls, its exit codes and what it writes.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { workflow, repo, run } from './hooks-fixtures.test.mjs';

function settingsOf(root) {
  return JSON.parse(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'));
}

function configOf(root) {
  const cmd = settingsOf(root).hooks.PreToolUse.at(-1).hooks[0].command;
  const path = /"([^"]+hooks\.json)"/.exec(cmd)[1];
  return JSON.parse(readFileSync(path, 'utf8'));
}

describe('usage errors exit 2', () => {
  test('no arguments', () => assert.equal(run([]).status, 2));
  test('no phase', () => assert.equal(run(['--worktree', '.']).status, 2));
  test('an unknown phase', () => {
    const r = run(['--worktree', '.', '--phase', 'deploy']);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--phase must be one of implement, evaluate, merge/);
  });
  test('an unknown flag', () => assert.equal(run(['--worktree', '.', '--phase', 'implement', '--force']).status, 2));
  test('a worktree that does not exist', () => assert.equal(run(['--worktree', join(tmpdir(), 'no-such-wt-x9'), '--phase', 'implement']).status, 2));
  test('a folder that is not a git work tree', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crankharness-nogit-'));
    assert.equal(run(['--worktree', dir, '--phase', 'implement']).status, 2);
  });
  test('an empty --touches', () => assert.equal(run(['--worktree', '.', '--phase', 'implement', '--touches', ' , ']).status, 2));
});

describe('a worktree that cannot take the hooks exits 1', () => {
  test('no WORKFLOW.md', () => {
    const root = repo({ 'README.md': 'x\n' });
    const r = run(['--worktree', root, '--phase', 'implement']);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no WORKFLOW\.md/);
  });
});

describe('installed: exit 0', () => {
  test('settings.local.json points at hooks/pretooluse.mjs and hooks/stop.mjs', () => {
    const root = repo();
    const r = run(['--worktree', root, '--phase', 'implement', '--touches', 'src/app/**, tests/app*.test.mjs']);
    assert.equal(r.status, 0, r.stderr);
    const s = settingsOf(root);
    assert.equal(s.hooks.PreToolUse.length, 1);
    assert.equal(s.hooks.PreToolUse[0].matcher, '*');
    assert.equal(s.hooks.PreToolUse[0].hooks[0].type, 'command');
    assert.match(s.hooks.PreToolUse[0].hooks[0].command, /^node "[^"]+\/hooks\/pretooluse\.mjs" "[^"]+\/crankharness\/hooks\.json"$/);
    assert.match(s.hooks.Stop[0].hooks[0].command, /^node "[^"]+\/hooks\/stop\.mjs" "[^"]+"$/);
    const c = configOf(root);
    assert.equal(c.phase, 'implement');
    assert.deepEqual(c.touches, ['src/app/**', 'tests/app*.test.mjs']);
    assert.equal(c.issue, 'ROB-9');
    assert.equal(c.gate.local, 'tools/local-ci.sh <ref> 0');
    assert.equal(c.caps.wall_minutes, 90);
  });

  test('--caps puts the issue\'s own caps over WORKFLOW.md\'s (ROB-407, dispatch 3)', () => {
    const root = repo();
    const r = run(['--worktree', root, '--phase', 'implement', '--touches', 'src/**', '--caps', 'wall_minutes=150,turns=80']);
    assert.equal(r.status, 0, r.stderr);
    const c = configOf(root);
    assert.equal(c.caps.wall_minutes, 150);
    assert.equal(c.caps.turns, 80);
    assert.equal(c.caps.cycles, 8); // untouched keys keep WORKFLOW.md's value
    assert.equal(run(['--worktree', root, '--phase', 'implement', '--caps', 'hours=2']).status, 2);
  });

  test('the hook config lives in the git folder, not in the files a worker edits', () => {
    const root = repo();
    run(['--worktree', root, '--phase', 'evaluate']);
    const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' });
    assert.equal(status, '', 'the install leaves git status clean (settings.local.json is excluded)');
  });

  test('a second install replaces its own hooks and keeps everything else', () => {
    const root = repo();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: { allow: ['Bash(npm test)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }] },
    }));
    assert.equal(run(['--worktree', root, '--phase', 'implement']).status, 0);
    assert.equal(run(['--worktree', root, '--phase', 'merge']).status, 0);
    const s = settingsOf(root);
    assert.deepEqual(s.permissions, { allow: ['Bash(npm test)'] });
    assert.equal(s.hooks.PreToolUse.length, 2);
    assert.equal(s.hooks.PreToolUse[0].hooks[0].command, 'echo mine');
    assert.equal(s.hooks.Stop.length, 1);
    assert.equal(configOf(root).phase, 'merge');
  });

  test('without --touches, WORKFLOW.md touches.default decides', () => {
    const none = repo({ 'WORKFLOW.md': workflow({ touches: 'none' }) });
    assert.equal(run(['--worktree', none, '--phase', 'implement']).status, 0);
    assert.equal(configOf(none).touches, null);
    const list = repo({ 'WORKFLOW.md': workflow({ touches: 'src/**, docs/**' }) });
    assert.equal(run(['--worktree', list, '--phase', 'implement']).status, 0);
    assert.deepEqual(configOf(list).touches, ['src/**', 'docs/**']);
    const lane = repo();
    const r = run(['--worktree', lane, '--phase', 'implement']);
    assert.equal(r.status, 0);
    assert.match(r.stderr, /pass --touches/);
    assert.equal(configOf(lane).touches, null);
  });

  test('a settings.local.json that is not JSON is not overwritten', () => {
    const root = repo();
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.local.json'), '{ not json');
    assert.equal(run(['--worktree', root, '--phase', 'implement']).status, 1);
    assert.equal(readFileSync(join(root, '.claude', 'settings.local.json'), 'utf8'), '{ not json');
  });

  test('--worktree may be a sub-folder of the work tree', () => {
    const root = repo({ 'WORKFLOW.md': workflow(), 'src/a.js': 'x\n' });
    assert.equal(run([`--worktree=${join(root, 'src')}`, '--phase=implement']).status, 0);
    assert.ok(existsSync(join(root, '.claude', 'settings.local.json')));
  });
});
