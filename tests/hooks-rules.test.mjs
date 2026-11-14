// Every PreToolUse rule of hooks/rules.json, both ways: one call it refuses, one it lets through.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { decide, loadRules, normPath, parseBash, globMatches, commandText } from '../hooks/lib.mjs';

const rules = loadRules();
const root = mkdtempSync(join(tmpdir(), 'crankharness-hooks-'));
mkdirSync(join(root, 'tests'), { recursive: true });
writeFileSync(join(root, 'tests', 'old.test.mjs'), '// a test someone else wrote\n');
const WT = normPath(root);
const OUTSIDE = process.platform === 'win32' ? 'C:/Windows/crankharness-outside.txt' : '/etc/crankharness-outside.txt';

function config(over = {}) {
  return {
    worktree: WT,
    phase: 'implement',
    touches: ['src/app/**'],
    caps: { cycles: 8, same_failure: 3, turns: 80, wall_minutes: 90 },
    started_at: new Date().toISOString(),
    tmp: normPath(tmpdir()),
    ...over,
  };
}

const bash = (command) => ({ tool_name: 'Bash', tool_input: { command }, cwd: root });
const write = (file_path) => ({ tool_name: 'Write', tool_input: { file_path, content: 'x' }, cwd: root });
const edit = (file_path) => ({ tool_name: 'Edit', tool_input: { file_path, old_string: 'a', new_string: 'b' }, cwd: root });
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path }, cwd: root });

function refused(input, rule, over) {
  const r = decide(input, config(over), rules);
  assert.equal(r.decision, 'deny', `expected [${rule}] to refuse ${JSON.stringify(input.tool_input)}`);
  assert.equal(r.rule, rule);
  assert.match(r.reason, new RegExp(`^CrankHarness denied \\[${rule}\\]`));
}

function allowed(input, over) {
  const r = decide(input, config(over), rules);
  assert.equal(r.decision, 'allow', `expected to allow ${JSON.stringify(input.tool_input)}, got: ${r.reason}`);
}

describe('secrets: never read, written or named', () => {
  test('refused', () => {
    refused(read(join(root, '.env')), 'secrets');
    refused(read(join(root, 'config', '.env.production')), 'secrets');
    refused(read(join(root, 'certs', 'server.pem')), 'secrets');
    refused(read(join(homedir(), '.ssh', 'id_rsa')), 'secrets');
    refused(read(join(homedir(), '.claude', '.credentials.json')), 'secrets');
    refused(write(join(root, '.dev.vars')), 'secrets');
    refused(bash('cat .env'), 'secrets');
    refused(bash('source ./.env.local && npm start'), 'secrets');
    refused(bash('ls ~/.ssh'), 'secrets');
    refused(bash('cp .env.example .env'), 'secrets');
    refused({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '.env*' }, cwd: root }, 'secrets');
    refused({ tool_name: 'Glob', tool_input: { pattern: '**/*.pem' }, cwd: root }, 'secrets');
  });
  test('allowed', () => {
    allowed(read(join(root, 'src', 'env.js')));
    allowed(read(join(root, 'README.md')));
    allowed(bash('cat README.md'));
    allowed({ tool_name: 'Grep', tool_input: { pattern: 'KEY', glob: '*.js' }, cwd: root });
    allowed({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.mjs' }, cwd: root });
  });
});

describe('ci-config: .github/** only when the Touches name it', () => {
  test('refused', () => {
    refused(write(join(root, '.github', 'workflows', 'ci.yml')), 'ci-config');
    refused(write(join(root, '.github', 'workflows', 'ci.yml')), 'ci-config', { touches: ['**'] });
    refused(bash('echo x > .github/workflows/ci.yml'), 'ci-config');
  });
  test('allowed', () => {
    allowed(write(join(root, '.github', 'workflows', 'ci.yml')), { touches: ['.github/workflows/**'] });
    allowed(read(join(root, '.github', 'workflows', 'ci.yml')));
  });
});

describe('deploy-config: wrangler.toml only when the Touches name it', () => {
  test('refused', () => refused(edit(join(root, 'wrangler.toml')), 'deploy-config', { touches: null }));
  test('allowed', () => {
    allowed(edit(join(root, 'wrangler.toml')), { touches: ['wrangler.toml'] });
    allowed(read(join(root, 'wrangler.toml')));
  });
});

describe('release-scripts: never edited, never run', () => {
  test('refused', () => {
    refused(write(join(root, 'tools', 'release-prod.sh')), 'release-scripts', { touches: ['tools/**'] });
    refused(bash('bash tools/release-prod.sh'), 'release-scripts');
    refused(bash('./tools/release-1.sh v2'), 'release-scripts');
  });
  test('allowed', () => {
    allowed(bash('tools/local-ci.sh HEAD 0'));
    allowed(write(join(root, 'tools', 'lint.sh')), { touches: ['tools/**'] });
  });
});

describe('harness-files: the hooks, their settings and .git', () => {
  test('refused', () => {
    refused(write(join(root, '.claude', 'settings.local.json')), 'harness-files', { touches: null });
    refused(edit(join(root, '.claude', 'settings.json')), 'harness-files', { touches: ['.claude/**'] });
    refused(bash('echo "[core]" >> .git/config'), 'harness-files', { touches: null });
  });
  test('allowed', () => allowed(write(join(root, '.claude', 'commands', 'x.md')), { touches: ['.claude/commands/**'] }));
});

describe('project-rules: AGENTS.md, CLAUDE.md, WORKFLOW.md by hand', () => {
  test('refused', () => {
    refused(edit(join(root, 'AGENTS.md')), 'project-rules', { touches: null });
    refused(edit(join(root, 'WORKFLOW.md')), 'project-rules', { phase: 'merge', touches: null });
  });
  test('allowed', () => allowed(edit(join(root, 'AGENTS.md')), { touches: ['AGENTS.md'] }));
});

describe('force-push', () => {
  test('refused, in every phase', () => {
    for (const phase of ['implement', 'evaluate', 'merge']) {
      refused(bash('git push --force'), phase === 'evaluate' ? 'force-push' : 'force-push', { phase });
    }
    refused(bash('git push -f origin agent/ROB-1-x'), 'force-push');
    refused(bash('git push --force-with-lease origin agent/ROB-1-x'), 'force-push');
    refused(bash('git push origin +agent/ROB-1-x'), 'force-push');
    refused(bash('git -C ../x push -uf origin y'), 'force-push');
    refused(bash('npm test && git push --force'), 'force-push');
    refused(bash('bash -c "git push -f"'), 'force-push');
    refused(bash('echo $(git push --force)'), 'force-push');
    refused(bash('GIT_TRACE=1 git push --force'), 'force-push');
  });
  test('allowed', () => {
    allowed(bash('git push origin agent/ROB-1-x'));
    allowed(bash('git push -u origin agent/ROB-1-fix-flags'));
    allowed(bash('git push --follow-tags origin agent/ROB-1-x'));
  });
});

describe('push-to-main', () => {
  test('refused', () => {
    refused(bash('git push origin main'), 'push-to-main');
    refused(bash('git push origin HEAD:main'), 'push-to-main', { phase: 'merge' });
    refused(bash('git push origin HEAD:refs/heads/master'), 'push-to-main');
  });
  test('allowed', () => {
    allowed(bash('git push origin agent/main-menu'));
    allowed(bash('git merge origin/main'));
  });
});

describe('deploy: no profile deploys', () => {
  test('refused, in every phase', () => {
    for (const phase of ['implement', 'evaluate', 'merge']) refused(bash('wrangler deploy'), 'deploy', { phase });
    refused(bash('npx wrangler deploy --env production'), 'deploy');
    refused(bash('npx -y wrangler@3 pages deploy dist'), 'deploy');
    refused(bash('wrangler secret put TOKEN'), 'deploy');
    refused(bash('npm publish'), 'deploy');
    refused(bash('npm run deploy'), 'deploy');
    refused(bash('gh workflow run release.yml'), 'deploy');
  });
  test('allowed', () => {
    allowed(bash('wrangler dev'));
    allowed(bash('npm run build'));
    allowed(bash('npm test'));
  });
});

describe('merge-pr: only the merge profile merges', () => {
  test('refused', () => {
    refused(bash('gh pr merge 12 --squash'), 'merge-pr');
    refused(bash('gh pr merge 12'), 'merge-pr', { phase: 'evaluate' });
  });
  test('allowed', () => {
    allowed(bash('gh pr merge 12 --squash'), { phase: 'merge' });
    allowed(bash('gh pr view 12'));
  });
});

describe('evaluate-read-only: the evaluator commits and pushes nothing', () => {
  test('refused', () => {
    refused(bash('git commit -m "x"'), 'evaluate-read-only', { phase: 'evaluate' });
    refused(bash('git push origin agent/x'), 'evaluate-read-only', { phase: 'evaluate' });
    refused(bash('gh pr edit 12 --body x'), 'evaluate-read-only', { phase: 'evaluate' });
  });
  test('allowed', () => {
    allowed(bash('git commit -m "x"'));
    allowed(bash('git log --merges --oneline'), { phase: 'evaluate' });
    allowed(bash('git diff origin/main...HEAD'), { phase: 'evaluate' });
    allowed(bash('npm test'), { phase: 'evaluate' });
  });
});

describe('read-only-phase: the evaluate phase writes no file', () => {
  test('refused', () => {
    refused(write(join(root, 'src', 'app', 'x.js')), 'read-only-phase', { phase: 'evaluate' });
    refused(bash('echo hi > out.txt'), 'read-only-phase', { phase: 'evaluate' });
  });
  test('allowed', () => {
    allowed(bash(`echo hi > "${normPath(join(tmpdir(), 'crankharness-eval.txt'))}"`), { phase: 'evaluate' });
    allowed(read(join(root, 'src', 'app', 'x.js')), { phase: 'evaluate' });
  });
});

describe('outside-worktree', () => {
  test('refused', () => {
    refused(write(OUTSIDE), 'outside-worktree', { touches: null });
    refused(bash(`cp src/app/a.js ${OUTSIDE}`), 'outside-worktree', { touches: null });
    refused(edit(OUTSIDE), 'outside-worktree', { phase: 'merge', touches: null });
  });
  test('allowed', () => {
    allowed(write(join(tmpdir(), 'scratch.txt')), { touches: null });
    allowed(bash('echo x > /dev/null; npm test 2>&1 >/dev/null'));
    allowed(write(join(root, 'anything.txt')), { phase: 'merge', touches: null });
  });
});

describe('outside-touches: the Touches are the lease', () => {
  test('refused', () => {
    refused(write(join(root, 'src', 'other.js')), 'outside-touches');
    refused(edit(join(root, 'tests', 'old.test.mjs')), 'outside-touches');
    refused(bash('rm src/other.js'), 'outside-touches');
    refused(bash('sed -i "s/a/b/" src/other.js'), 'outside-touches');
    refused(bash('cd src && echo x > other.js'), 'outside-touches');
    refused(bash('mv src/app/a.js src/b.js'), 'outside-touches');
  });
  test('allowed', () => {
    allowed(write(join(root, 'src', 'app', 'x.js')));
    allowed(edit(join(root, 'PROGRESS.md')));
    allowed(write(join(root, 'for-rob', 'ROB-1.md')));
    allowed(write(join(root, 'tests', 'new.test.mjs')));
    allowed(bash('echo hi > src/app/y.js'));
    allowed(bash('cd src/app && echo x > z.js'));
    allowed(write(join(root, 'src', 'other.js')), { touches: null });
  });
});

describe('cap-wall-time: past the cap, only the wrap-up', () => {
  const late = { started_at: new Date(Date.now() - 2 * 60 * 60_000).toISOString() };
  test('refused', () => {
    refused(edit(join(root, 'src', 'app', 'x.js')), 'cap-wall-time', late);
    refused(bash('npm test'), 'cap-wall-time', late);
    refused({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } }, 'cap-wall-time', late);
  });
  test('allowed', () => {
    allowed(edit(join(root, 'PROGRESS.md')), late);
    allowed(bash('git add src/app/x.js && git commit -m "checkpoint"'), late);
    allowed(read(join(root, 'PROGRESS.md')), late);
    allowed(bash('npm test'));
  });
  test('the cap does not unlock a force-push', () => refused(bash('git push --force'), 'force-push', late));
});

describe('unknown-phase: a config without a known phase refuses everything', () => {
  test('refused', () => refused(read(join(root, 'README.md')), 'unknown-phase', { phase: 'deploy' }));
  test('allowed', () => allowed(read(join(root, 'README.md')), { phase: 'evaluate' }));
});

describe('the Bash reader', () => {
  test('a here-document body is text, not commands', () => {
    allowed(bash("cat > notes.md <<'EOF'\ngit push --force\nwrangler deploy\nEOF\necho done"), { touches: null });
    refused(bash("cat > notes.md <<'EOF'\ntext\nEOF\ngit push --force"), 'force-push', { touches: null });
  });
  test('quotes, redirections and nested commands', () => {
    const segs = parseBash(`echo "a b" 2>&1 > 'out file.txt' && (cd x; ls) | tee log.txt`);
    assert.deepEqual(segs[0].words, ['echo', 'a b']);
    assert.deepEqual(segs[0].redirects, [{ op: '>', target: 'out file.txt' }]);
    assert.deepEqual(segs.map((s) => s.words[0]), ['echo', 'cd', 'ls', 'tee']);
    assert.equal(commandText(['env', 'A=1', 'C:\\Program Files\\Git\\cmd\\git.exe', 'push']), 'git push');
  });
  test('globs', () => {
    assert.ok(globMatches('.env.*', 'config/.env.local', null));
    assert.ok(!globMatches('.env.*', 'config/env.local', null));
    assert.ok(globMatches('src/**', 'src/a/b/c.js', null));
    assert.ok(globMatches('src/**/*.js', 'src/c.js', null));
    assert.ok(!globMatches('src/*.js', 'src/a/c.js', null));
    assert.ok(globMatches('{src,lib}/*.js', 'lib/c.js', null));
    assert.ok(globMatches('**/.ssh/**', null, '/home/u/.ssh/id_rsa'));
  });
  test('paths: Git Bash and Windows spellings are one path', () => {
    if (process.platform !== 'win32') return;
    assert.equal(normPath('/c/Users/x/a.txt'), 'c:/Users/x/a.txt');
    assert.equal(normPath('C:\\Users\\x\\a.txt'), 'c:/Users/x/a.txt');
  });
});

describe('pretooluse.mjs, the process Claude Code runs', () => {
  const script = resolve(import.meta.dirname, '..', 'hooks', 'pretooluse.mjs');
  const cfgPath = join(root, 'hook-config.json');
  writeFileSync(cfgPath, JSON.stringify(config({ rules_path: normPath(resolve(import.meta.dirname, '..', 'hooks', 'rules.json')), log_path: normPath(join(root, 'log.jsonl')) })));
  const run = (args, input) => spawnSync(process.execPath, [script, ...args], { input: JSON.stringify(input), encoding: 'utf8' });

  test('a refusal is the documented PreToolUse JSON and names the rule', () => {
    const r = run([cfgPath], bash('git push --force'));
    assert.equal(r.status, 0);
    const out = JSON.parse(r.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\[force-push\]/);
  });
  test('an allowed call prints nothing', () => {
    const r = run([cfgPath], bash('npm test'));
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
  });
  test('a hook that cannot read its config refuses (fails closed)', () => {
    const r = run([join(root, 'missing.json')], bash('npm test'));
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /\[hook-error\]/);
  });
});
