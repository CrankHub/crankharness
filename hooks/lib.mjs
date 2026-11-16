// Shared code for the CrankHarness hooks: globs, paths, the hook config, the Bash parser and the
// PreToolUse decision. No dependencies (Node 22).

import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HOOKS_DIR = dirname(fileURLToPath(import.meta.url));
export const RULES_PATH = resolve(HOOKS_DIR, 'rules.json');
export const PHASES = ['implement', 'evaluate', 'merge'];
const WIN = process.platform === 'win32';

export function loadRules(path = RULES_PATH) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

export function appendLog(config, entry) {
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  const targets = [config?.log_path];
  if (process.env.CRANKHARNESS_RUN_DIR) targets.push(resolve(process.env.CRANKHARNESS_RUN_DIR, 'hooks.jsonl'));
  for (const t of targets) {
    if (!t) continue;
    try {
      mkdirSync(dirname(t), { recursive: true });
      appendFileSync(t, line);
    } catch {
      // the log is a record, never a reason to fail the hook
    }
  }
}

// --- paths -------------------------------------------------------------------------------------

// One spelling for every path: absolute, forward slashes, a lower-case drive letter on Windows,
// and Git Bash's /c/... turned into c:/...
export function normPath(p, cwd = process.cwd()) {
  let s = String(p).trim();
  if (WIN) {
    const m = /^\/([a-zA-Z])(\/|$)/.exec(s);
    if (m) s = `${m[1]}:/${s.slice(3)}`;
    if (s === '~' || s.startsWith('~/')) s = (process.env.USERPROFILE || process.env.HOME || '~') + s.slice(1);
  } else if (s === '~' || s.startsWith('~/')) {
    s = (process.env.HOME || '~') + s.slice(1);
  }
  s = isAbsolute(s) ? resolve(s) : resolve(cwd, s);
  s = s.replace(/\\/g, '/');
  if (/^[A-Z]:\//.test(s)) s = s[0].toLowerCase() + s.slice(1);
  return s;
}

// The path relative to the root, or null when it is outside it.
export function relInside(root, abs) {
  const r = root.replace(/\/+$/, '');
  const a = WIN ? abs.toLowerCase() : abs;
  const b = WIN ? r.toLowerCase() : r;
  if (a === b) return '';
  if (a.startsWith(b + '/')) return abs.slice(r.length + 1);
  return null;
}

// --- globs -------------------------------------------------------------------------------------

const globCache = new Map();

export function globToRegExp(glob) {
  const key = glob;
  if (globCache.has(key)) return globCache.get(key);
  let re = '';
  let i = 0;
  let inBrace = false;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atStart = i === 0 || glob[i - 1] === '/';
        const atEnd = i + 2 === glob.length || glob[i + 2] === '/';
        if (atStart && atEnd) {
          if (glob[i + 2] === '/') {
            re += '(?:.*/)?';
            i += 3;
          } else {
            re += '.*';
            i += 2;
          }
          continue;
        }
        re += '[^/]*';
        i += 2;
        continue;
      }
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '{') {
      inBrace = true;
      re += '(?:';
    } else if (c === '}' && inBrace) {
      inBrace = false;
      re += ')';
    } else if (c === ',' && inBrace) {
      re += '|';
    } else {
      re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
    }
    i += 1;
  }
  const out = new RegExp(`^${re}$`, WIN ? 'i' : '');
  globCache.set(key, out);
  return out;
}

// Does the glob match this path? rel is the path inside the worktree (or null), abs the absolute
// path. A glob without a / matches the file name at any depth; a glob starting with **/ also
// matches absolute paths outside the worktree.
export function globMatches(glob, rel, abs) {
  const g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globToRegExp(g);
  if (!g.includes('/')) {
    const name = (rel ?? abs).split('/').pop();
    return re.test(name);
  }
  if (rel !== null && rel !== undefined && re.test(rel)) return true;
  if (g.startsWith('**/') && abs) return re.test(abs);
  if (isAbsolute(g) || /^[a-zA-Z]:\//.test(g)) return abs ? re.test(abs) : false;
  return false;
}

export function anyGlob(globs, rel, abs) {
  return (globs || []).find((g) => globMatches(g, rel, abs)) ?? null;
}

// --- the Bash parser ---------------------------------------------------------------------------
//
// Splits a command into simple commands, each with its words and its redirections. It knows
// quotes, escapes, ; && || | & and new lines, $( ) and backticks (kept inside a word and parsed
// again), and here-documents (their bodies are text, not commands). It is a fence for an agent
// that follows the rules, not a sandbox: a program that writes files by itself is not seen.

export function parseBash(command) {
  const segments = [];
  let words = [];
  let redirects = [];
  let word = null;
  let pendingRedirect = null;
  const heredocs = [];
  const s = String(command);
  let i = 0;

  const endWord = () => {
    if (word === null) return;
    if (pendingRedirect) {
      if (pendingRedirect === '<<') heredocs.push(word.replace(/^-/, ''));
      else redirects.push({ op: pendingRedirect, target: word });
      pendingRedirect = null;
    } else {
      words.push(word);
    }
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (words.length || redirects.length) segments.push({ words, redirects });
    words = [];
    redirects = [];
  };
  const skipHeredocs = () => {
    // called at a new line: skip the bodies of the here-documents opened on the line
    while (heredocs.length) {
      const delim = heredocs.shift();
      while (i < s.length) {
        const nl = s.indexOf('\n', i);
        const line = nl === -1 ? s.slice(i) : s.slice(i, nl);
        i = nl === -1 ? s.length : nl + 1;
        if (line.trim() === delim) break;
      }
    }
  };
  const readNested = (open, close) => {
    // returns the text up to the matching close, i positioned after it
    let depth = 1;
    let out = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) {
        out += c + s[i + 1];
        i += 2;
        continue;
      }
      if (open && s.startsWith(open, i)) depth += 1;
      if (s.startsWith(close, i)) {
        depth -= 1;
        if (depth === 0) {
          i += close.length;
          return out;
        }
      }
      out += c;
      i += 1;
    }
    return out;
  };

  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      if (s[i + 1] === '\n') {
        i += 2;
        continue;
      }
      word = (word ?? '') + (s[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      word = (word ?? '') + s.slice(i + 1, end === -1 ? s.length : end);
      i = end === -1 ? s.length : end + 1;
      continue;
    }
    if (c === '"') {
      i += 1;
      let out = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        if (s.startsWith('$(', i)) {
          i += 2;
          out += '$(' + readNested('$(', ')') + ')';
          continue;
        }
        out += s[i];
        i += 1;
      }
      i += 1;
      word = (word ?? '') + out;
      continue;
    }
    if (s.startsWith('$(', i)) {
      i += 2;
      word = (word ?? '') + '$(' + readNested('$(', ')') + ')';
      continue;
    }
    if (c === '`') {
      i += 1;
      word = (word ?? '') + '`' + readNested(null, '`') + '`';
      continue;
    }
    if (c === '\n') {
      endSegment();
      i += 1;
      skipHeredocs();
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i += 1;
      continue;
    }
    if (c === '#' && word === null) {
      const nl = s.indexOf('\n', i);
      i = nl === -1 ? s.length : nl;
      continue;
    }
    if (c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
      if (c === '&' && s[i + 1] === '>') {
        endWord();
        const append = s[i + 2] === '>';
        pendingRedirect = append ? '>>' : '>';
        i += append ? 3 : 2;
        continue;
      }
      endSegment();
      i += s[i + 1] === c ? 2 : 1;
      continue;
    }
    if (c === '>' || c === '<') {
      if (word !== null && /^\d+$/.test(word)) word = null; // 2> and the like
      endWord();
      if (c === '<' && s[i + 1] === '<') {
        if (s[i + 2] === '<') {
          i += 3; // here-string: the next word is text
          pendingRedirect = '<<<';
          continue;
        }
        i += s[i + 2] === '-' ? 3 : 2;
        pendingRedirect = '<<';
        continue;
      }
      if (c === '>' && s[i + 1] === '&') {
        // >&2, >&1: a descriptor, not a file
        i += 2;
        while (i < s.length && /[0-9-]/.test(s[i])) i += 1;
        continue;
      }
      const append = c === '>' && s[i + 1] === '>';
      pendingRedirect = c === '<' ? '<' : append ? '>>' : '>';
      i += append ? 2 : 1;
      if (s[i] === '|') i += 1; // >|
      continue;
    }
    word = (word ?? '') + c;
    i += 1;
  }
  endSegment();

  // here-strings are text; nested commands are parsed again
  const out = [];
  for (const seg of segments) {
    seg.redirects = seg.redirects.filter((r) => r.op !== '<<<');
    out.push(seg);
    for (const w of seg.words) {
      for (const inner of nestedCommands(w)) out.push(...parseBash(inner));
    }
    const prog = programName(stripWrappers(seg.words)[0] ?? '');
    const rest = stripWrappers(seg.words).slice(1);
    if (['bash', 'sh', 'zsh', 'dash', 'ksh'].includes(prog)) {
      const ci = rest.findIndex((w) => /^-[a-z]*c$/.test(w));
      if (ci !== -1 && rest[ci + 1]) out.push(...parseBash(rest[ci + 1]));
    }
    if (['pwsh', 'powershell', 'cmd'].includes(prog)) {
      const ci = rest.findIndex((w) => /^[-/](c|command)$/i.test(w));
      if (ci !== -1) out.push(...parseBash(rest.slice(ci + 1).join(' ')));
    }
    if (prog === 'eval' && rest.length) out.push(...parseBash(rest.join(' ')));
  }
  return out;
}

function nestedCommands(word) {
  const found = [];
  let i = 0;
  while (i < word.length) {
    if (word.startsWith('$(', i)) {
      let depth = 1;
      let j = i + 2;
      while (j < word.length && depth > 0) {
        if (word.startsWith('$(', j)) {
          depth += 1;
          j += 2;
          continue;
        }
        if (word[j] === ')') depth -= 1;
        j += 1;
      }
      found.push(word.slice(i + 2, depth === 0 ? j - 1 : j));
      i = j;
      continue;
    }
    if (word[i] === '`') {
      const end = word.indexOf('`', i + 1);
      if (end === -1) break;
      found.push(word.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return found;
}

export function programName(word) {
  const base = String(word).replace(/\\/g, '/').split('/').pop();
  return base.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();
}

// Drops what runs another command: VAR=value, env, sudo, nohup, time, command, exec, nice,
// timeout <n>, xargs and npx-style runners.
export function stripWrappers(words) {
  let w = [...words];
  for (let guard = 0; guard < 10 && w.length; guard += 1) {
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0])) {
      w = w.slice(1);
      continue;
    }
    const p = programName(w[0]);
    if (['env', 'sudo', 'nohup', 'time', 'command', 'exec', 'nice', 'xargs', 'npx', 'bunx', 'winpty'].includes(p)) {
      w = w.slice(1);
      while (w.length && w[0].startsWith('-')) w = w.slice(1);
      continue;
    }
    if (['pnpm', 'yarn'].includes(p) && ['dlx', 'exec'].includes(w[1])) {
      w = w.slice(2);
      continue;
    }
    if (p === 'timeout') {
      w = w.slice(1);
      while (w.length && w[0].startsWith('-')) w = w.slice(1);
      if (w.length && /^\d/.test(w[0])) w = w.slice(1);
      continue;
    }
    break;
  }
  return w;
}

// The text a command rule's patterns are tested against: the program's plain name, then its
// words, joined by spaces.
export function commandText(words) {
  const w = stripWrappers(words);
  if (!w.length) return '';
  const first = /\.(sh|mjs|js|py)$/i.test(w[0]) ? w[0].replace(/\\/g, '/') : programName(w[0]);
  return [first, ...w.slice(1)].join(' ');
}

const WRITE_ALL_ARGS = ['rm', 'rmdir', 'touch', 'mkdir', 'truncate', 'tee', 'unlink', 'shred', 'chmod', 'chown', 'ln'];

// The files a simple command writes, as far as a reader of the command can tell.
export function writeTargets(seg) {
  const targets = seg.redirects.filter((r) => r.op === '>' || r.op === '>>').map((r) => r.target);
  const w = stripWrappers(seg.words);
  if (!w.length) return targets;
  const prog = programName(w[0]);
  const args = w.slice(1).filter((a) => !a.startsWith('-'));
  if (WRITE_ALL_ARGS.includes(prog)) {
    let a = args;
    if (prog === 'chmod' || prog === 'chown') a = a.slice(1);
    targets.push(...a);
  } else if (prog === 'mv') {
    targets.push(...args);
  } else if (prog === 'cp' || prog === 'install' || prog === 'rsync') {
    if (args.length) targets.push(args[args.length - 1]);
  } else if (prog === 'sed' || prog === 'perl') {
    if (w.slice(1).some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) {
      const hasScriptFlag = w.slice(1).some((a) => a === '-e' || a === '-f' || a === '--expression');
      targets.push(...(hasScriptFlag ? args.slice(0) : args.slice(1)));
    }
  } else if (prog === 'dd') {
    for (const a of w.slice(1)) if (a.startsWith('of=')) targets.push(a.slice(3));
  }
  return targets.filter((t) => t && !t.startsWith('$('));
}

// Every word that could name a file, for the secrets check.
export function mentionedPaths(seg) {
  const out = [];
  for (const raw of [...seg.words, ...seg.redirects.map((r) => r.target)]) {
    if (!raw || raw.startsWith('$(') || raw.startsWith('`')) continue;
    out.push(raw);
    const eq = raw.lastIndexOf('=');
    if (eq !== -1) out.push(raw.slice(eq + 1));
    const colon = raw.lastIndexOf(':');
    if (colon > 1) out.push(raw.slice(colon + 1));
    if (/[*?[\]]/.test(raw)) out.push(raw.replace(/[*?[\]]/g, ''));
  }
  return [...new Set(out.filter((p) => p && !/^-/.test(p) && !/^[a-z]+:\/\//i.test(p)))];
}

// --- the decision ------------------------------------------------------------------------------

function deny(rule, why, detail) {
  return { decision: 'deny', rule, reason: `CrankHarness denied [${rule}]: ${why}${detail ? ` (${detail})` : ''}` };
}

function phaseRules(list, phase) {
  return (list || []).filter((r) => !r.phases || r.phases.includes(phase));
}

function touchUnlocks(config, rel) {
  if (rel === null || !Array.isArray(config.touches)) return false;
  return config.touches.some((g) => !g.startsWith('*') && globMatches(g, rel, null));
}

function isWritableOutside(rules, config, raw, abs) {
  const list = (rules.scope?.outside_worktree?.writable || []).map((g) => (g === '<tmp>' ? `${config.tmp}/**` : g));
  return list.some((g) => {
    if (g === raw || g === abs) return true;
    if (g.startsWith('/') || /^[a-zA-Z]:\//.test(g)) {
      const re = globToRegExp(g.replace(/\\/g, '/'));
      return re.test(String(raw).replace(/\\/g, '/')) || re.test(abs);
    }
    return false;
  });
}

function checkSecrets(rules, config, abs, phase) {
  const rel = relInside(config.worktree, abs);
  for (const r of phaseRules(rules.paths, phase)) {
    if (r.access !== 'any') continue;
    const g = anyGlob(r.globs, rel, abs);
    if (g) return deny(r.id, r.why, `${rel ?? abs} matches ${g}`);
  }
  return null;
}

// Every check a write to one path must pass, in order.
export function checkWrite(rules, config, raw, cwd, { tool = 'write' } = {}) {
  const phase = config.phase;
  const abs = normPath(raw, cwd);
  const rel = relInside(config.worktree, abs);
  const secret = checkSecrets(rules, config, abs, phase);
  if (secret) return secret;
  if (rel === null) {
    if (isWritableOutside(rules, config, raw, abs)) return null;
    const s = rules.scope.outside_worktree;
    return deny(s.id, s.why, `${abs} is outside ${config.worktree}`);
  }
  for (const r of phaseRules(rules.paths, phase)) {
    if (r.access !== 'write') continue;
    const g = anyGlob(r.globs, rel, abs);
    if (!g) continue;
    if (r.unless_touched && touchUnlocks(config, rel)) continue;
    return deny(r.id, r.why, `${rel} matches ${g}`);
  }
  const mode = rules.phases[phase]?.writes;
  if (mode === 'none') {
    const s = rules.scope.read_only_phase;
    return deny(s.id, `${s.why}: phase ${phase}`, rel);
  }
  // An empty folder changes nothing; every file later written into it is checked on its own.
  if (mode === 'touches' && Array.isArray(config.touches) && tool !== 'mkdir') {
    const s = rules.scope.outside_touches;
    if (anyGlob(config.touches, rel, abs)) return null;
    if (anyGlob(s.always_writable, rel, abs)) return null;
    if (tool === 'create' && !existsSync(abs) && anyGlob(s.new_tests, rel, abs)) return null;
    return deny(s.id, s.why, `${rel} is not in Touches: ${config.touches.join(', ')}`);
  }
  return null;
}

function wallCapSpent(config, now) {
  const minutes = config.caps?.wall_minutes;
  if (!Number.isFinite(minutes) || !config.started_at) return false;
  return now - Date.parse(config.started_at) > minutes * 60_000;
}

const READ_TOOLS = ['Read', 'Grep', 'Glob', 'LS', 'NotebookRead'];
const WRITE_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

// The PreToolUse decision for one hook input: { decision: 'allow' } or { decision: 'deny', rule, reason }.
export function decide(input, config, rules, { now = Date.now() } = {}) {
  const phase = config.phase;
  if (!rules.phases?.[phase]) return deny('unknown-phase', 'the hook config names no known phase', String(phase));
  const tool = input.tool_name || '';
  const ti = input.tool_input || {};
  const cwd = input.cwd || config.worktree;
  const capped = wallCapSpent(config, now);
  const cap = rules.caps?.wall_time;

  if (READ_TOOLS.includes(tool)) {
    const paths = [ti.file_path, ti.path, ti.notebook_path].filter(Boolean);
    for (const p of paths) {
      const d = checkSecrets(rules, config, normPath(p, cwd), phase);
      if (d) return d;
    }
    const globs = [tool === 'Grep' ? ti.glob : null, tool === 'Glob' ? ti.pattern : null].filter(Boolean);
    for (const g of globs) {
      const d = checkSecrets(rules, config, normPath(String(g).replace(/[*?[\]{}]/g, ''), cwd), phase);
      if (d) return d;
    }
    return { decision: 'allow' };
  }

  if (WRITE_TOOLS.includes(tool)) {
    const target = ti.file_path || ti.notebook_path;
    if (!target) return { decision: 'allow' };
    if (capped) {
      const rel = relInside(config.worktree, normPath(target, cwd));
      if (!(rel !== null && anyGlob(cap.still_allowed_writes, rel, null))) {
        return deny(cap.id, cap.why, `${config.caps.wall_minutes} minutes`);
      }
    }
    const d = checkWrite(rules, config, target, cwd, { tool: tool === 'Write' ? 'create' : 'edit' });
    return d ?? { decision: 'allow' };
  }

  if (tool === 'Bash' || tool === 'PowerShell') {
    const segments = parseBash(ti.command || '');
    let segCwd = cwd;
    for (const seg of segments) {
      const text = commandText(seg.words);
      const plain = stripWrappers(seg.words);
      if (programName(plain[0] ?? '') === 'cd' && plain[1] && !plain[1].startsWith('-')) {
        segCwd = normPath(plain[1], segCwd);
      }
      if (capped && text && !(cap.still_allowed_commands || []).some((p) => new RegExp(p).test(text))) {
        return deny(cap.id, cap.why, `${config.caps.wall_minutes} minutes`);
      }
      for (const r of phaseRules(rules.commands, phase)) {
        const p = r.patterns.find((pat) => new RegExp(pat).test(text));
        if (p) return deny(r.id, r.why, text.length > 120 ? text.slice(0, 117) + '...' : text);
      }
      for (const m of mentionedPaths(seg)) {
        const d = checkSecrets(rules, config, normPath(m, segCwd), phase);
        if (d) return d;
      }
      const w = stripWrappers(seg.words);
      const isMkdir = w.length > 0 && programName(w[0]) === 'mkdir';
      for (const t of writeTargets(seg)) {
        const d = checkWrite(rules, config, t, segCwd, { tool: isMkdir ? 'mkdir' : 'create' });
        if (d) return d;
      }
    }
    return { decision: 'allow' };
  }

  if (capped && !READ_TOOLS.includes(tool) && !/^(TodoWrite|Task\w*)$/.test(tool)) {
    return deny(cap.id, cap.why, `${config.caps.wall_minutes} minutes`);
  }
  return { decision: 'allow' };
}
