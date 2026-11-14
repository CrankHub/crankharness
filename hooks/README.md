# The hooks: the fence around a headless worker (ROB-405)

A worker is told the rules in `AGENTS.md`. The hooks make the most important rules hold even if
the worker ignores them. Claude Code runs a hook before every tool call and when the session tries
to end. A hook's refusal holds in every permission mode, `bypassPermissions` included.

## How the dispatch script uses them

```bash
node hooks/install.mjs --worktree <path> --phase implement|evaluate|merge [--touches <glob,...>]
```

- Writes `<worktree>/.claude/settings.local.json` with two hooks: `hooks/pretooluse.mjs` (before
  every tool call) and `hooks/stop.mjs` (when the session tries to end). Other settings in that
  file are kept.
- Puts the phase, the Touches, the caps and the gate commands in `hooks.json` inside the
  worktree's git folder (`<git dir>/crankharness/`). That folder is never committed and is outside
  the files a worker may edit. The hook log, `hooks.jsonl`, sits beside it.
- Exit 0 when installed, 1 when the worktree cannot take the hooks (no `WORKFLOW.md`, or a
  settings file that is not JSON), 2 on a usage error.
- With no `--touches`, `touches.default` in `WORKFLOW.md` decides: `none` means the whole
  worktree, a path list is used as it is. `lane` cannot be read by the hooks, so pass `--touches`.

## What is refused (`hooks/rules.json`)

The rules are data, not code. Each refusal names its rule, for example
`CrankHarness denied [force-push]: never force-push; ...`, and is written to the log.

| Rule | Refused | Phases |
| --- | --- | --- |
| `secrets` | reading, writing or naming `.env*`, `.dev.vars*`, `*.pem`, `*.key`, SSH and cloud keys, the login file | all |
| `ci-config` | editing `.github/**` (allowed when the issue's Touches name it) | all |
| `deploy-config` | editing `wrangler.toml` (allowed when the Touches name it) | all |
| `release-scripts` | editing or running `tools/release-*.sh` | all |
| `harness-files` | editing `.claude/settings*.json`, `.claude/hooks/**`, `.git/**` | all |
| `project-rules` | editing `AGENTS.md`, `CLAUDE.md`, `WORKFLOW.md` (allowed when the Touches name them) | all |
| `force-push` | `git push --force`, `-f`, `--force-with-lease`, `+branch` | all |
| `push-to-main` | pushing to `main` or `master` | all |
| `deploy` | `wrangler deploy`, `wrangler secret`, `npm publish`, `npm run deploy`, `gh release`, `gh workflow run` | all |
| `merge-pr` | `gh pr merge` | implement, evaluate (only the merge phase may merge) |
| `evaluate-read-only` | `git commit`, `git push` and other history changes, PR edits | evaluate |
| `read-only-phase` | writing any file | evaluate |
| `outside-worktree` | writing outside the worktree (the temp folder is allowed) | all |
| `outside-touches` | writing a file outside the issue's Touches; `PROGRESS.md`, `for-rob/**` and new test files are allowed | implement |
| `cap-wall-time` | everything but reading, `git add/commit/push` and `PROGRESS.md`, once `caps.wall_minutes` is spent | all |

If the hook itself fails, it refuses: a fence that fails open is not a fence.

## When the session tries to end (`hooks/stop.mjs`)

1. It runs the gate from `WORKFLOW.md`: each command in `gate.stop` (optional: lint, typecheck,
   the touched tests), then `gate.local`. In a command, `<ref>` is a commit of HEAD plus the
   task's uncommitted files (exactly what would be committed), `<files>` the changed files and
   `<tests>` the touched tests.
2. The gate fails: the session may not end. Claude reads the failure and carries on.
3. It failed `caps.cycles` times, or `caps.same_failure` times the same way: the session ends and
   the hand-off to the evaluator is written to the log and the hook state.
4. It passes: in the implement phase, the task's files (inside Touches) are committed, and only
   those. Other changed files are left alone and named in the log.

The evaluate phase runs no gate. The merge phase runs the gate and commits nothing.

## What the fence does not see

The Bash check reads the command the way a person would: it finds force-pushes, deploys, secret
file names and the files that `>`, `cp`, `mv`, `rm`, `sed -i` and the like write. A program that
writes files by itself (`node -e`, a Python script) is not seen. The backstop is the definition of
done: the diff must stay inside Touches, and the evaluator and the merge agent check that.

## The proof

```bash
node hooks/live-proof.mjs [--out <folder>] [--offline]
```

It builds a throwaway repository and worktree, installs the hooks, and runs a real headless
worker (`claude -p`, `bypassPermissions`) that tries each refused action, then a second worker
whose gate fails until it fixes its file. It needs the `claude` subscription login; without it,
`--offline` checks only the installed commands. The record is `live-proof.json` in the folder.
