// Shared fixtures for the hooks tests: a WORKFLOW.md, a throwaway git repository on an agent
// branch, and hooks/install.mjs run as the dispatch script runs it. One check of its own: the
// fixture's WORKFLOW.md is one the contract check reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, execFileSync } from 'node:child_process';
import { parseFrontMatter } from '../check-contract.mjs';

const INSTALL = resolve(import.meta.dirname, '..', 'hooks', 'install.mjs');

export function workflow({ touches = 'lane', gateLocal = 'tools/local-ci.sh <ref> 0', gateStop = null } = {}) {
  return [
    '---',
    'harness: crankharness',
    'contract: 1',
    'project: CrankHub/example',
    'tracker:',
    '  kind: linear',
    '  states:',
    '    todo: Todo',
    '    in_progress: In Progress',
    '    blocked: Blocked',
    '    done: Done',
    'concurrency: 3',
    'branch:',
    '  pattern: agent/<ISSUE-ID>-<slug>',
    'gate:',
    `  local: ${gateLocal}`,
    ...(gateStop ? ['  stop:', ...gateStop.map((c) => `    - ${c}`)] : []),
    'touches:',
    `  default: ${touches}`,
    'verify:',
    '  skill: .claude/skills/verify/SKILL.md',
    '  feature_map: .claude/skills/verify/feature-map.md',
    'caps:',
    '  cycles: 8',
    '  same_failure: 3',
    '  turns: 80',
    '  wall_minutes: 90',
    '---',
    '',
  ].join('\n');
}

export function repo(files = { 'WORKFLOW.md': workflow() }, branch = 'agent/ROB-9-example') {
  const root = mkdtempSync(join(tmpdir(), 'crankharness-install-'));
  const g = (...a) => execFileSync('git', a, { cwd: root, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 'test@example.invalid');
  g('config', 'commit.gpgsign', 'false');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(root, name, '..'), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  g('add', '-A');
  g('commit', '-q', '-m', 'init');
  g('checkout', '-q', '-b', branch);
  return root;
}

export function run(args) {
  return spawnSync(process.execPath, [INSTALL, ...args], { encoding: 'utf8' });
}

test('the fixture WORKFLOW.md is one the contract check reads', () => {
  const { data, error } = parseFrontMatter(workflow({ gateStop: ['npm run lint'] }));
  assert.equal(error, undefined);
  assert.equal(data.gate.local, 'tools/local-ci.sh <ref> 0');
  assert.deepEqual(data.gate.stop, ['npm run lint']);
});
