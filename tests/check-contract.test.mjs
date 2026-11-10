import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkContract, parseFrontMatter, sectionsPresent, SECTIONS, render } from '../check-contract.mjs';

function project(overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'crankharness-'));
  const files = {
    'AGENTS.md': [
      '# Rules',
      '',
      '## The harness',
      '',
      '### Mission',
      'one issue per session',
      '### Scope rules',
      '### Phase permissions',
      '### Stop conditions',
      '### For Rob to confirm',
      '### Done: the rule',
      '',
      '## Something of the project',
      '',
      '### Definition of done',
    ].join('\n'),
    'CLAUDE.md': 'Read `AGENTS.md` first.\n',
    'WORKFLOW.md': [
      '---',
      'harness: crankharness',
      'contract: 1',
      'project: CrankHub/example',
      'tracker:',
      '  kind: linear',
      '  team: ROB',
      '  states:',
      '    todo: Todo',
      '    in_progress: In Progress',
      '    blocked: Blocked',
      '    done: Done',
      'concurrency: 3',
      'branch:',
      '  pattern: agent/<ISSUE-ID>-<slug>',
      'gate:',
      '  local: tools/local-ci.sh <ref> 0',
      'touches:',
      '  default: lane',
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
      '# prose',
    ].join('\n'),
    'tools/local-ci.sh': '#!/bin/sh\nexit 0\n',
    '.claude/skills/verify/SKILL.md': '---\nname: verify\ndescription: run the app\n---\n# verify\n',
    '.claude/skills/verify/feature-map.md': '# Feature map\n',
    ...overrides,
  };
  for (const [rel, content] of Object.entries(files)) {
    if (content === null) continue;
    mkdirSync(join(root, rel, '..'), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return root;
}

test('a complete project passes', () => {
  const root = project();
  const r = checkContract(root);
  assert.equal(r.pass, true, render(root, r));
  assert.equal(r.pending, 0);
  assert.match(render(root, r), /\nPASS$/);
  rmSync(root, { recursive: true, force: true });
});

test('an empty folder names every part', () => {
  const root = mkdtempSync(join(tmpdir(), 'crankharness-empty-'));
  const r = checkContract(root);
  const text = render(root, r);
  assert.equal(r.pass, false);
  assert.equal(r.missing, 3);
  assert.match(text, /MISSING\s+AGENTS\.md/);
  assert.match(text, /MISSING\s+CLAUDE\.md/);
  assert.match(text, /MISSING\s+WORKFLOW\.md/);
  assert.match(text, /\nFAIL: 3 missing$/);
  rmSync(root, { recursive: true, force: true });
});

test('a verify skill that is pending passes, and fails under --strict', () => {
  const root = project({
    '.claude/skills/verify/SKILL.md': null,
    '.claude/skills/verify/feature-map.md': null,
    'WORKFLOW.md': null,
  });
  writeFileSync(
    join(root, 'WORKFLOW.md'),
    [
      '---',
      'harness: crankharness',
      'contract: 1',
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
      '  local: tools/local-ci.sh <ref> 0',
      'touches:',
      '  default: lane',
      'verify:',
      '  skill: .claude/skills/verify/SKILL.md',
      '  feature_map: .claude/skills/verify/feature-map.md',
      '  pending: ROB-401',
      'caps:',
      '  cycles: 8',
      '  same_failure: 3',
      '  turns: 80',
      '  wall_minutes: 90',
      '---',
    ].join('\n'),
  );
  const r = checkContract(root);
  assert.equal(r.pass, true, render(root, r));
  assert.equal(r.pending, 1);
  assert.match(render(root, r), /pending\s+verify skill: .*ROB-401/);
  assert.match(render(root, r), /\nPASS \(1 pending\)$/);
  const s = checkContract(root, { strict: true });
  assert.equal(s.pass, false);
  assert.match(render(root, s), /MISSING\s+verify skill/);
  rmSync(root, { recursive: true, force: true });
});

test('a missing verify skill with no pending issue is MISSING', () => {
  const root = project({ '.claude/skills/verify/feature-map.md': null });
  const r = checkContract(root);
  assert.equal(r.pass, false);
  assert.match(render(root, r), /MISSING\s+verify skill: feature map/);
  rmSync(root, { recursive: true, force: true });
});

test('absent AGENTS.md sections are named', () => {
  const root = project({ 'AGENTS.md': '# Rules\n\n## Mission\n\n## Done\n' });
  const r = checkContract(root);
  assert.equal(r.pass, false);
  assert.match(render(root, r), /MISSING\s+AGENTS\.md: 4 of 6 sections absent: Scope rules, Phase permissions, Stop conditions, For Rob to confirm/);
  rmSync(root, { recursive: true, force: true });
});

test('a local gate that names a file that is not there is MISSING', () => {
  const root = project({ 'tools/local-ci.sh': null });
  const r = checkContract(root);
  assert.equal(r.pass, false);
  assert.match(render(root, r), /MISSING\s+local gate: tools\/local-ci\.sh <ref> 0 names tools\/local-ci\.sh/);
  rmSync(root, { recursive: true, force: true });
});

test('WORKFLOW.md keys are checked one by one', () => {
  const root = project();
  writeFileSync(join(root, 'WORKFLOW.md'), '---\nharness: other\nconcurrency: zero\nbranch:\n  pattern: agent/x\n---\n');
  const r = checkContract(root);
  const text = render(root, r);
  assert.match(text, /harness equals crankharness/);
  assert.match(text, /contract absent/);
  assert.match(text, /concurrency an integer of at least 1/);
  assert.match(text, /branch\.pattern contains <ISSUE-ID>/);
  assert.match(text, /tracker\.states\.blocked absent/);
  rmSync(root, { recursive: true, force: true });
});

test('the front-matter parser reads nested maps and lists', () => {
  const { data } = parseFrontMatter('---\na: 1\nb:\n  c: "two"\n  d:\n    - x\n    - 3\ne: In Progress\n---\nbody');
  assert.deepEqual(data, { a: 1, b: { c: 'two', d: ['x', 3] }, e: 'In Progress' });
  assert.match(parseFrontMatter('no front matter').error, /does not start with ---/);
  assert.match(parseFrontMatter('---\na: 1\n').error, /no closing ---/);
});

test('section headings match at any level, with or without a suffix', () => {
  const md = '# Mission\n## Scope rules: ours\n### Phase permissions (harness)\n#### Stop conditions\n## For Rob to confirm\n## Done — the rule\n## Definition of done\n';
  assert.deepEqual(sectionsPresent(md), SECTIONS);
  assert.deepEqual(sectionsPresent('## Missionary\n## Doneness\n'), []);
});
