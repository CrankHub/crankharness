#!/usr/bin/env node
// Installs the CrankHarness hooks into one worktree, for one phase.
//
//   node hooks/install.mjs --worktree <path> --phase implement|evaluate|merge [--touches <glob,...>]
//
// Writes <worktree>/.claude/settings.local.json with a PreToolUse hook (hooks/pretooluse.mjs) and
// a Stop hook (hooks/stop.mjs), keeping any other settings already there. The phase, the Touches,
// the caps and the gate commands from the project's WORKFLOW.md go into a hook config inside the
// worktree's git folder (never committed, outside the files a worker may edit), with the run's
// log and the Stop hook's counters beside it.
//
// Exit 0 when installed, 1 when the worktree cannot take the hooks (no WORKFLOW.md, or one the
// check cannot read), 2 on a usage error.

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseFrontMatter } from '../check-contract.mjs';
import { HOOKS_DIR, RULES_PATH, PHASES, normPath, readJson } from './lib.mjs';

const USAGE = 'usage: node hooks/install.mjs --worktree <path> --phase implement|evaluate|merge [--touches <glob,...>]';
const MARK = /hooks[\\/](pretooluse|stop)\.mjs/;

export class UsageError extends Error {}
export class InstallError extends Error {}

export function parseArgs(argv) {
  const out = { touches: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const [flag, inline] = a.startsWith('--') && eq !== -1 ? [a.slice(0, eq), a.slice(eq + 1)] : [a, null];
    const value = () => {
      if (inline !== null) return inline;
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      i += 1;
      return v;
    };
    if (flag === '--worktree') out.worktree = value();
    else if (flag === '--phase') out.phase = value();
    else if (flag === '--touches') out.touches = value();
    else if (flag === '--help' || flag === '-h') throw new UsageError('');
    else throw new UsageError(`unknown argument: ${a}`);
  }
  if (!out.worktree) throw new UsageError('--worktree is required');
  if (!out.phase) throw new UsageError('--phase is required');
  if (!PHASES.includes(out.phase)) throw new UsageError(`--phase must be one of ${PHASES.join(', ')}, got: ${out.phase}`);
  if (out.touches !== null) {
    out.touches = out.touches.split(',').map((g) => g.trim()).filter(Boolean);
    if (!out.touches.length) throw new UsageError('--touches names no glob');
  }
  return out;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A command, or a list of commands; the YAML reader turns a bare `true` or `0` into a value,
// so those come back as the text they were.
function asList(v) {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== '').map(String);
  if (v === null || v === undefined || v === '') return [];
  return [String(v).trim()];
}

function touchesFromWorkflow(value) {
  if (Array.isArray(value)) return { touches: value.map(String), source: 'workflow' };
  const v = String(value ?? '').trim();
  if (v === '' || v === 'none') return { touches: null, source: 'none' };
  if (v.includes('/') || v.includes('*') || v.includes(',')) {
    return { touches: v.split(',').map((g) => g.trim()).filter(Boolean), source: 'workflow' };
  }
  // "lane" is the project's own idea (named in its AGENTS.md); the hooks cannot resolve it.
  return { touches: null, source: `unresolved: ${v}` };
}

export function install({ worktree, phase, touches = null }) {
  if (!existsSync(worktree) || !statSync(worktree).isDirectory()) throw new UsageError(`--worktree is not a folder: ${worktree}`);
  let top;
  let gitDir;
  let commonDir;
  let branch = '';
  try {
    top = normPath(git(worktree, 'rev-parse', '--show-toplevel'));
    gitDir = normPath(git(worktree, 'rev-parse', '--absolute-git-dir'));
    commonDir = normPath(git(worktree, 'rev-parse', '--git-common-dir'), top);
  } catch {
    throw new UsageError(`--worktree is not inside a git work tree: ${worktree}`);
  }
  try {
    branch = git(top, 'rev-parse', '--abbrev-ref', 'HEAD');
  } catch {
    branch = '';
  }

  const workflowPath = join(top, 'WORKFLOW.md');
  if (!existsSync(workflowPath)) throw new InstallError(`no WORKFLOW.md in ${top}: run check-contract on the project first`);
  const parsed = parseFrontMatter(readFileSync(workflowPath, 'utf8'));
  if (parsed.error) throw new InstallError(`WORKFLOW.md: ${parsed.error}`);
  const wf = parsed.data;

  let touchesSource = 'flag';
  if (touches === null) {
    const t = touchesFromWorkflow(wf.touches?.default);
    touches = t.touches;
    touchesSource = t.source;
  }

  const stateDir = `${gitDir}/crankharness`;
  mkdirSync(stateDir, { recursive: true });
  const configPath = `${stateDir}/hooks.json`;
  const rules = readJson(RULES_PATH, null);
  if (!rules) throw new InstallError(`cannot read ${RULES_PATH}`);
  const issue = /[A-Z][A-Z0-9]*-\d+/.exec(branch)?.[0] ?? null;

  const config = {
    harness: 'crankharness',
    worktree: top,
    phase,
    touches,
    touches_source: touchesSource,
    issue,
    branch,
    base_ref: 'origin/main',
    caps: {
      cycles: wf.caps?.cycles ?? 8,
      same_failure: wf.caps?.same_failure ?? 3,
      turns: wf.caps?.turns ?? 80,
      wall_minutes: wf.caps?.wall_minutes ?? 90,
    },
    gate: { local: asList(wf.gate?.local)[0] ?? null, stop: asList(wf.gate?.stop) },
    started_at: new Date().toISOString(),
    tmp: normPath(tmpdir()),
    rules_path: normPath(RULES_PATH),
    log_path: `${stateDir}/hooks.jsonl`,
    state_path: `${stateDir}/stop-state.json`,
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
  writeFileSync(config.state_path, JSON.stringify({ attempts: 0, same_failure: 0, last_failure: null }, null, 2) + '\n');

  // .claude/settings.local.json: keep what is there, replace our two hooks
  const settingsDir = join(top, '.claude');
  mkdirSync(settingsDir, { recursive: true });
  const settingsPath = join(settingsDir, 'settings.local.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    settings = readJson(settingsPath, null);
    if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
      throw new InstallError(`${settingsPath} is not a JSON object; fix or remove it`);
    }
  }
  const hooksDir = normPath(HOOKS_DIR);
  const command = (script) => `node "${hooksDir}/${script}" "${configPath}"`;
  settings.hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  for (const event of ['PreToolUse', 'Stop']) {
    const groups = Array.isArray(settings.hooks[event]) ? settings.hooks[event] : [];
    settings.hooks[event] = groups
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !MARK.test(h.command || '')) }))
      .filter((g) => g.hooks.length);
  }
  settings.hooks.PreToolUse.push({ matcher: '*', hooks: [{ type: 'command', command: command('pretooluse.mjs'), timeout: 30 }] });
  settings.hooks.Stop.push({ hooks: [{ type: 'command', command: command('stop.mjs'), timeout: rules.stop?.timeout_seconds ?? 1800 }] });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

  // never committed: the local settings file is the session's, not the project's
  try {
    const exclude = join(commonDir, 'info', 'exclude');
    mkdirSync(join(commonDir, 'info'), { recursive: true });
    const text = existsSync(exclude) ? readFileSync(exclude, 'utf8') : '';
    if (!text.split(/\r?\n/).includes('.claude/settings.local.json')) {
      writeFileSync(exclude, text + (text && !text.endsWith('\n') ? '\n' : '') + '.claude/settings.local.json\n');
    }
  } catch {
    // a missing exclude line only means git status shows the file
  }

  return { config, configPath, settingsPath: normPath(settingsPath) };
}

function main(argv) {
  try {
    const opts = parseArgs(argv);
    const { config, configPath, settingsPath } = install({
      worktree: resolve(opts.worktree),
      phase: opts.phase,
      touches: opts.touches,
    });
    const lines = [
      `hooks installed: phase ${config.phase} in ${config.worktree}`,
      `  settings  ${settingsPath}`,
      `  config    ${configPath}`,
      `  touches   ${config.touches ? config.touches.join(', ') : 'none (the whole worktree)'} (${config.touches_source})`,
      `  gate      ${[...config.gate.stop, config.gate.local].filter(Boolean).join(' ; ') || 'none'}`,
      `  log       ${config.log_path}`,
    ];
    process.stdout.write(lines.join('\n') + '\n');
    if (config.touches_source.startsWith('unresolved')) {
      process.stderr.write(`install: WORKFLOW.md touches.default is "${config.touches_source.slice(12)}", which the hooks cannot resolve; pass --touches. Writes are fenced to the worktree only.\n`);
    }
    return 0;
  } catch (err) {
    if (err instanceof UsageError) {
      if (err.message) process.stderr.write(`install: ${err.message}\n`);
      process.stderr.write(USAGE + '\n');
      return 2;
    }
    process.stderr.write(`install: ${err.message}\n`);
    return 1;
  }
}

if (process.argv[1] && normPath(process.argv[1]) === normPath(fileURLToPath(import.meta.url))) {
  process.exitCode = main(process.argv.slice(2));
}
