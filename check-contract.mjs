#!/usr/bin/env node
// check-contract: does a project repository provide what CONTRACT.md asks of it?
//
//   node check-contract.mjs <path-to-repository> [--strict]
//
// Prints one line per part (ok, pending, MISSING, note), then PASS, PASS (n pending) or
// FAIL: n missing. Exit 0 on PASS, 1 on FAIL, 2 on a usage error. --strict makes a pending
// verify skill a MISSING part (how the daemon runs it once the project's verify skill exists).
//
// No dependencies: the YAML front matter the contract allows is a small subset (nested maps of
// scalars and lists of scalars) and is parsed here.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SECTIONS = [
  'Mission',
  'Scope rules',
  'Phase permissions',
  'Stop conditions',
  'For Rob to confirm',
  'Done',
];

const WORKFLOW_KEYS = [
  ['harness', (v) => v === 'crankharness', 'equals crankharness'],
  ['contract', (v) => v === 1, 'is 1'],
  ['tracker.kind', (v) => typeof v === 'string' && v.length > 0, 'present'],
  ['tracker.states.todo', nonEmpty, 'present'],
  ['tracker.states.in_progress', nonEmpty, 'present'],
  ['tracker.states.blocked', nonEmpty, 'present'],
  ['tracker.states.done', nonEmpty, 'present'],
  ['concurrency', (v) => Number.isInteger(v) && v >= 1, 'an integer of at least 1'],
  ['branch.pattern', (v) => typeof v === 'string' && v.includes('<ISSUE-ID>'), 'contains <ISSUE-ID>'],
  ['gate.local', nonEmpty, 'present'],
  ['touches.default', nonEmpty, 'present'],
  ['verify.skill', nonEmpty, 'present'],
  ['verify.feature_map', nonEmpty, 'present'],
  ['caps.cycles', isInt, 'an integer'],
  ['caps.same_failure', isInt, 'an integer'],
  ['caps.turns', isInt, 'an integer'],
  ['caps.wall_minutes', isInt, 'an integer'],
];

function nonEmpty(v) {
  return (typeof v === 'string' && v.trim().length > 0) || typeof v === 'number';
}
function isInt(v) {
  return Number.isInteger(v);
}

// --- a YAML subset: nested maps of scalars, lists of scalars, two-space indentation ---------

function scalar(raw) {
  const s = raw.trim();
  if (s === '') return '';
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (/^-?\d+$/.test(s)) return Number(s);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null' || s === '~') return null;
  return s;
}

export function parseFrontMatter(text) {
  const lines = text.split(/\r?\n/);
  if (lines[0] !== '---') return { error: 'no front matter: the file does not start with ---' };
  const end = lines.indexOf('---', 1);
  if (end === -1) return { error: 'no front matter: the opening --- has no closing ---' };
  const body = lines.slice(1, end).filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const rows = body.map((l) => ({ indent: l.length - l.trimStart().length, text: l.trim() }));
  let i = 0;
  function block(indent) {
    const out = {};
    let list = null;
    while (i < rows.length && rows[i].indent >= indent) {
      const row = rows[i];
      if (row.indent > indent) return { error: `unexpected indentation at "${row.text}"` };
      if (row.text.startsWith('- ')) {
        if (list === null) list = [];
        list.push(scalar(row.text.slice(2)));
        i += 1;
        continue;
      }
      const m = /^([A-Za-z0-9_.-]+):(.*)$/.exec(row.text);
      if (!m) return { error: `not a key: "${row.text}"` };
      const key = m[1];
      const rest = m[2];
      i += 1;
      if (rest.trim() === '') {
        if (i < rows.length && rows[i].indent > indent) {
          const sub = block(rows[i].indent);
          if (sub.error) return sub;
          out[key] = sub;
        } else {
          out[key] = '';
        }
      } else {
        out[key] = scalar(rest);
      }
    }
    if (list !== null) return list;
    return out;
  }
  const data = block(0);
  if (data.error) return { error: data.error };
  return { data };
}

function get(obj, path) {
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

// --- the headings of AGENTS.md -------------------------------------------------------------

export function sectionsPresent(markdown) {
  const found = new Set();
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const heading = m[1].replace(/[`*_]/g, '').trim().toLowerCase();
    for (const name of SECTIONS) {
      const n = name.toLowerCase();
      if (heading === n || /^[\s:(·—-]/.test(heading.slice(n.length)) && heading.startsWith(n)) {
        found.add(name);
      }
    }
  }
  return SECTIONS.filter((s) => found.has(s));
}

// --- the check ----------------------------------------------------------------------------

export function checkContract(root, { strict = false } = {}) {
  const lines = [];
  let missing = 0;
  let pending = 0;
  const ok = (msg) => lines.push(`  ok       ${msg}`);
  const note = (msg) => lines.push(`  note     ${msg}`);
  const miss = (msg) => {
    missing += 1;
    lines.push(`  MISSING  ${msg}`);
  };
  const pend = (msg) => {
    if (strict) return miss(`${msg} (pending is missing under --strict)`);
    pending += 1;
    lines.push(`  pending  ${msg}`);
  };
  const file = (rel) => join(root, rel);
  const isFile = (rel) => existsSync(file(rel)) && statSync(file(rel)).isFile();

  if (!existsSync(root) || !statSync(root).isDirectory()) {
    return { lines: [`  MISSING  ${root} is not a directory`], missing: 1, pending: 0, pass: false };
  }

  // 1. AGENTS.md with the six sections
  if (!isFile('AGENTS.md')) {
    miss('AGENTS.md: no file at the repository root (CONTRACT.md, part 1)');
  } else {
    const present = sectionsPresent(readFileSync(file('AGENTS.md'), 'utf8'));
    const absent = SECTIONS.filter((s) => !present.includes(s));
    if (absent.length === 0) {
      ok(`AGENTS.md: ${SECTIONS.length}/${SECTIONS.length} sections (${SECTIONS.join(', ')})`);
    } else {
      miss(`AGENTS.md: ${absent.length} of ${SECTIONS.length} sections absent: ${absent.join(', ')} (templates/AGENTS.sections.md, merged by hand)`);
    }
  }

  // 2. CLAUDE.md pointing at AGENTS.md
  if (!isFile('CLAUDE.md')) {
    miss('CLAUDE.md: no file at the repository root (CONTRACT.md, part 2: a pointer at AGENTS.md)');
  } else if (!/AGENTS\.md/.test(readFileSync(file('CLAUDE.md'), 'utf8'))) {
    miss('CLAUDE.md: does not name AGENTS.md (CONTRACT.md, part 2)');
  } else {
    ok('CLAUDE.md points at AGENTS.md');
  }

  // 3. WORKFLOW.md front matter
  let wf = null;
  if (!isFile('WORKFLOW.md')) {
    miss('WORKFLOW.md: no file at the repository root (CONTRACT.md, part 3; templates/WORKFLOW.md)');
  } else {
    const parsed = parseFrontMatter(readFileSync(file('WORKFLOW.md'), 'utf8'));
    if (parsed.error) {
      miss(`WORKFLOW.md: ${parsed.error}`);
    } else {
      wf = parsed.data;
      const bad = [];
      for (const [key, test, want] of WORKFLOW_KEYS) {
        const v = get(wf, key);
        if (v === undefined || v === '') bad.push(`${key} absent`);
        else if (!test(v)) bad.push(`${key} ${want} (is ${JSON.stringify(v)})`);
      }
      if (bad.length) {
        miss(`WORKFLOW.md: ${bad.join('; ')}`);
      } else {
        const st = wf.tracker.states;
        ok(`WORKFLOW.md: states ${st.todo}/${st.in_progress}/${st.blocked}/${st.done}, concurrency ${wf.concurrency}, branch ${wf.branch.pattern}, touches default ${wf.touches.default}, caps ${wf.caps.cycles}/${wf.caps.same_failure}/${wf.caps.turns}/${wf.caps.wall_minutes}`);
      }
    }
  }

  // The local gate
  if (wf && nonEmpty(get(wf, 'gate.local'))) {
    const cmd = String(wf.gate.local).trim();
    const first = cmd.split(/\s+/)[0];
    const looksLikeFile = first.includes('/') || /\.(sh|mjs|js|cjs|py|ps1|cmd|bat)$/.test(first);
    if (looksLikeFile) {
      if (isFile(first)) ok(`local gate: ${cmd} (${first} exists)`);
      else miss(`local gate: ${cmd} names ${first}, which is not a file in the repository`);
    } else {
      note(`local gate: ${cmd} (a bare command; not checked for existence)`);
    }
  } else if (wf) {
    miss('local gate: WORKFLOW.md gate.local absent');
  }

  // 4. The verify skill and its feature map
  if (wf) {
    const skill = get(wf, 'verify.skill');
    const map = get(wf, 'verify.feature_map');
    const pendingKey = get(wf, 'verify.pending');
    const haveSkill = nonEmpty(skill) && isFile(String(skill));
    const haveMap = nonEmpty(map) && isFile(String(map));
    if (haveSkill && haveMap) {
      const front = readFileSync(file(String(skill)), 'utf8');
      const fm = parseFrontMatter(front);
      if (fm.error || !nonEmpty(get(fm.data, 'name')) || !nonEmpty(get(fm.data, 'description'))) {
        miss(`verify skill: ${skill} exists but is not a skill (front matter with name and description)`);
      } else {
        ok(`verify skill: ${skill} with feature map ${map}`);
      }
    } else if (typeof pendingKey === 'string' && /^[A-Z][A-Z0-9]*-\d+$/.test(pendingKey.trim())) {
      pend(`verify skill: ${skill || '(unnamed)'} and ${map || '(unnamed)'} do not exist yet; building under ${pendingKey.trim()}`);
    } else {
      const which = [!haveSkill ? `skill ${skill || '(unnamed)'}` : null, !haveMap ? `feature map ${map || '(unnamed)'}` : null]
        .filter(Boolean)
        .join(' and ');
      miss(`verify skill: ${which} not found, and verify.pending names no issue (CONTRACT.md, part 4)`);
    }
  }

  const pass = missing === 0;
  return { lines, missing, pending, pass };
}

export function render(root, result) {
  const out = [`check-contract: ${root}`, ...result.lines];
  if (result.pass) out.push(result.pending ? `PASS (${result.pending} pending)` : 'PASS');
  else out.push(`FAIL: ${result.missing} missing`);
  return out.join('\n');
}

function main(argv) {
  const args = argv.filter((a) => !a.startsWith('--'));
  const strict = argv.includes('--strict');
  if (args.length !== 1) {
    console.error('usage: check-contract <path-to-repository> [--strict]');
    return 2;
  }
  const root = resolve(args[0]);
  const result = checkContract(root, { strict });
  console.log(render(root, result));
  return result.pass ? 0 : 1;
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) process.exit(main(process.argv.slice(2)));
