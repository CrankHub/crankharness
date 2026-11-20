#!/usr/bin/env node
// The Stop hook: the session may end only when the project's gate passes, or a cap is hit.
//
//   node hooks/stop.mjs <hook config>      (written by hooks/install.mjs; Claude Code runs it)
//
// On the Stop event it runs the gate from the project's WORKFLOW.md: each command of `gate.stop`
// (lint, typecheck, the touched tests; optional) and then `gate.local`. In the commands, <ref> is
// a commit of HEAD plus the task's uncommitted files (what would be committed), <files> the files
// the branch changed, and <tests> the tests it touched (a command whose <tests> is empty is
// skipped).
//
// - The gate fails: exit 2 with the diagnostics on stderr, so Claude reads them and goes on.
// - It failed caps.cycles times, or caps.same_failure times the same way: the stop is allowed,
//   the hand-off to the evaluator is recorded in the state and the log.
// - It passes: in the implement phase the task-owned files (inside Touches) are committed, and
//   only those; other changed files are left as they are and named in the log.

import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { checkWrite, loadRules, readJson, appendLog, anyGlob, normPath } from './lib.mjs';

function git(config, args, opts = {}) {
  return execFileSync('git', args, {
    cwd: config.worktree,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
    ...opts,
  });
}

function tryGit(config, args, opts) {
  try {
    return git(config, args, opts).trim();
  } catch {
    return null;
  }
}

// Uncommitted paths (tracked changes, deletions and untracked files), relative to the worktree.
export function uncommitted(config) {
  const out = git(config, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const parts = out.split('\0');
  const paths = [];
  for (let i = 0; i < parts.length; i += 1) {
    const p = parts[i];
    if (p.length < 4) continue;
    const xy = p.slice(0, 2);
    paths.push(p.slice(3));
    if (xy[0] === 'R' || xy[0] === 'C') i += 1; // the next entry is the old name
  }
  return paths;
}

function branchChanges(config) {
  const base = tryGit(config, ['merge-base', 'HEAD', config.base_ref || 'origin/main']);
  if (!base) return [];
  const out = tryGit(config, ['diff', '--name-only', `${base}`, 'HEAD']);
  return out ? out.split(/\r?\n/).filter(Boolean) : [];
}

function quote(p) {
  return `'${String(p).replace(/'/g, `'\\''`)}'`;
}

function touchedTests(config, rules, changed) {
  const testGlobs = rules.scope?.outside_touches?.new_tests || [];
  const tests = new Set(changed.filter((f) => anyGlob(testGlobs, f, null)));
  const stems = changed
    .filter((f) => !anyGlob(testGlobs, f, null))
    .map((f) => f.split('/').pop().replace(/\.[^.]+$/, ''))
    .filter((s) => s.length >= 3);
  if (stems.length) {
    const all = (tryGit(config, ['ls-files']) || '').split(/\r?\n/).filter((f) => anyGlob(testGlobs, f, null));
    for (const f of all) {
      const name = f.split('/').pop();
      if (stems.some((s) => name.includes(s))) tests.add(f);
    }
  }
  return [...tests].filter((f) => existsSync(`${config.worktree}/${f}`));
}

let bashPath;
function findBash() {
  if (bashPath !== undefined) return bashPath;
  const candidates = process.platform === 'win32'
    ? ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', 'bash']
    : ['bash', 'sh'];
  for (const c of candidates) {
    if (c.includes('/') && !existsSync(c)) continue;
    const r = spawnSync(c, ['-c', 'exit 0'], { stdio: 'ignore' });
    if (r.status === 0) return (bashPath = c);
  }
  return (bashPath = null);
}

function runCommand(config, command, timeoutMs) {
  const bash = findBash();
  const wrapped = `{ ${command}\n} 2>&1`;
  const r = bash
    ? spawnSync(bash, ['-c', wrapped], { cwd: config.worktree, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(command, { cwd: config.worktree, encoding: 'utf8', shell: true, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  const output = `${r.stdout || ''}${r.stderr || ''}`;
  if (r.error) return { code: 1, output: `${output}\n${r.error.code === 'ETIMEDOUT' ? 'timed out' : r.error.message}` };
  return { code: r.status ?? 1, output };
}

// A commit of HEAD with the task-owned files as they are now, made with a separate index so the
// worker's index and files are untouched. It is never on a branch.
function snapshot(config, owned) {
  if (!owned.length) return 'HEAD';
  const index = `${config.state_path.replace(/[^/]+$/, '')}index.snapshot`;
  const env = {
    ...process.env,
    GIT_INDEX_FILE: index,
    GIT_AUTHOR_NAME: 'CrankHarness Stop hook',
    GIT_AUTHOR_EMAIL: 'stop-hook@crankharness.invalid',
    GIT_COMMITTER_NAME: 'CrankHarness Stop hook',
    GIT_COMMITTER_EMAIL: 'stop-hook@crankharness.invalid',
  };
  try {
    git(config, ['read-tree', 'HEAD'], { env });
    git(config, ['add', '-A', '--', ...owned], { env });
    const tree = git(config, ['write-tree'], { env }).trim();
    return git(config, ['commit-tree', tree, '-p', 'HEAD', '-m', 'CrankHarness Stop hook snapshot'], { env }).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

// Timings come in both orders ("12 ms", "duration_ms: 3.04"); both are dropped, as are decimal
// numbers and hashes, so the same failure is counted as the same (CMD-21, dispatch 1).
export function signature(command, code, output) {
  const norm = output
    .replace(/\b(duration_ms|duration|elapsed|time)\b\s*[:=]?\s*\d+(\.\d+)?/gi, '$1')
    .replace(/\d+(\.\d+)?\s*(ms|s|seconds?)\b/g, '')
    .replace(/\d+\.\d+/g, '')
    .replace(/[0-9a-f]{7,40}/g, '')
    .slice(-2000);
  return createHash('sha1').update(`${command}\n${code}\n${norm}`).digest('hex').slice(0, 12);
}

// Returns { code, stdout, stderr }: what the hook process prints and its exit code.
export function runStop(input, config, rules) {
  const phaseStop = rules.stop?.phases?.[config.phase] ?? { gate: false, commit: false };
  const state = readJson(config.state_path, { attempts: 0, same_failure: 0, last_failure: null });
  const log = (entry) => appendLog(config, { event: 'stop', phase: config.phase, stop_hook_active: !!input.stop_hook_active, ...entry });
  const save = () => writeFileSync(config.state_path, JSON.stringify(state, null, 2) + '\n');
  const tailChars = rules.stop?.output_tail_chars ?? 6000;

  if (!phaseStop.gate) {
    log({ result: 'allowed', why: `no gate in the ${config.phase} phase` });
    return { code: 0 };
  }

  const fail = (command, code, output) => {
    const sig = signature(command, code, output);
    state.attempts = (state.attempts || 0) + 1;
    state.same_failure = state.last_failure === sig ? (state.same_failure || 1) + 1 : 1;
    state.last_failure = sig;
    const cycles = config.caps?.cycles ?? 8;
    const same = config.caps?.same_failure ?? 3;
    const tail = output.length > tailChars ? `...\n${output.slice(-tailChars)}` : output;
    if (state.attempts >= cycles || state.same_failure >= same) {
      const why = state.attempts >= cycles
        ? `the gate failed ${state.attempts} times (cap ${cycles})`
        : `the gate failed the same way ${state.same_failure} times (cap ${same})`;
      state.handoff = { at: new Date().toISOString(), why, command, exit: code };
      save();
      log({ result: 'handoff', why, command, exit: code, output: tail });
      return {
        code: 0,
        stdout: JSON.stringify({ systemMessage: `CrankHarness: ${why}; the session stops and the run goes to the evaluator.` }),
      };
    }
    save();
    log({ result: 'blocked', attempt: state.attempts, command, exit: code, output: tail });
    return {
      code: 2,
      stderr: [
        `CrankHarness Stop hook: the gate failed (attempt ${state.attempts} of ${cycles}). Fix it, then finish again.`,
        `command: ${command}`,
        `exit: ${code}`,
        tail.trimEnd(),
      ].join('\n') + '\n',
    };
  };

  try {
    const dirty = uncommitted(config);
    const changed = [...new Set([...branchChanges(config), ...dirty])];
    if (!changed.length) {
      log({ result: 'allowed', why: 'nothing changed' });
      return { code: 0 };
    }
    const owned = dirty.filter((f) => checkWrite(rules, config, f, config.worktree, { tool: 'edit' }) === null);
    const notOwned = dirty.filter((f) => !owned.includes(f));
    const ref = phaseStop.commit ? snapshot(config, owned) : 'HEAD';

    const commands = [...(config.gate?.stop || []), config.gate?.local].filter(Boolean);
    if (!commands.length) {
      log({ result: 'allowed', why: 'WORKFLOW.md names no gate command' });
      return { code: 0 };
    }
    const tests = touchedTests(config, rules, changed);
    const timeoutMs = Math.max(30, (rules.stop?.timeout_seconds ?? 1800) - 30) * 1000;
    const ran = [];
    for (const template of commands) {
      if (template.includes('<tests>') && !tests.length) {
        ran.push({ command: template, skipped: 'no touched tests' });
        continue;
      }
      const command = template
        .replaceAll('<ref>', ref)
        .replaceAll('<files>', changed.map(quote).join(' '))
        .replaceAll('<tests>', tests.map(quote).join(' '));
      const r = runCommand(config, command, timeoutMs);
      ran.push({ command, exit: r.code });
      if (r.code !== 0) return fail(template, r.code, r.output);
    }

    let committed = [];
    if (phaseStop.commit && owned.length) {
      try {
        git(config, ['add', '-A', '--', ...owned]);
        const msg = `${config.issue ? `${config.issue}: ` : ''}the task's files, committed after the gate passed (CrankHarness Stop hook)`;
        git(config, ['commit', '-m', msg, '--only', '--', ...owned]);
        committed = owned;
      } catch (err) {
        return fail('git commit (task-owned files)', 1, `${err.stdout || ''}${err.stderr || ''}${err.message}`);
      }
    }
    state.attempts = 0;
    state.same_failure = 0;
    state.last_failure = null;
    delete state.handoff;
    save();
    log({ result: 'passed', ran, committed, left_uncommitted: notOwned });
    return { code: 0 };
  } catch (err) {
    return fail('the Stop hook itself', 1, err.stack || String(err));
  }
}

function main() {
  let config = null;
  try {
    const configPath = process.argv[2];
    config = readJson(configPath, null);
    if (!config) throw new Error(`cannot read the hook config ${configPath}`);
    let input = {};
    try {
      input = JSON.parse(readFileSync(0, 'utf8') || '{}');
    } catch {
      input = {};
    }
    const r = runStop(input, config, loadRules(config.rules_path));
    if (r.stdout) process.stdout.write(r.stdout);
    if (r.stderr) process.stderr.write(r.stderr);
    return r.code;
  } catch (err) {
    // without a config there are no caps to count against: let the session end, and say why
    appendLog(config, { event: 'stop', result: 'hook-error', error: err.message });
    process.stdout.write(JSON.stringify({ systemMessage: `CrankHarness Stop hook could not run: ${err.message}` }));
    return 0;
  }
}

if (process.argv[1] && normPath(process.argv[1]) === normPath(fileURLToPath(import.meta.url))) {
  process.exitCode = main();
}
