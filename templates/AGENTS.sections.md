# The harness's sections of a project's `AGENTS.md`

CrankHarness (`CONTRACT.md`, part 1) asks every project's `AGENTS.md` to carry these six sections, each under a
heading whose text starts with the section's name. They are merged **by hand** into the file that exists: a
maintainer edits them in, keeps the project's own wording where it says more, and points at the project's rules where
they already cover a line. No agent generates or replaces `AGENTS.md` (the plan cites the finding that generated
files did not help while developer-written ones did). Text in `<angle brackets>` is the project's to fill in.

---

## Mission

You implement exactly one tracker issue per session. The issue body is the spec: its goal, its acceptance criteria,
its verification, its Touches, its caps and its blockers (CrankHarness `templates/issue.md`). If the spec is
ambiguous, ask on the issue (an elicitation on the agent session, or a comment) and stop; never widen or guess the
scope.

## Scope rules

- Touch only the files listed under Touches in the issue, plus their tests. When the issue lists no Touches, the
  lease is `<the project's default: its lane, named in WORKFLOW.md touches.default>`.
- Need another file? Ask on the issue instead of editing it. The orchestrator leases Touches: one file, one owner at a
  time, and overlapping issues are never co-scheduled.
- Do not edit CI config, `AGENTS.md`, lint rules, hooks, or tests you did not write unless the issue says so.
- Small, atomic commits with descriptive messages; one concern per PR; the PR opens as a draft and links the issue.

## Phase permissions

- Investigate and plan: read-only (read, search, list).
- Implement: write inside your worktree only, on your branch `<WORKFLOW.md branch.pattern>`. Never force-push; to
  catch up with main, merge `origin/main` into the branch.
- Never deploy. Only the merge agent merges. `<the project's release rule, if it has one>`
- Never create or use an API key: the session runs on a subscription login (Rob, Nov 2, 2026). Never commit secrets,
  `.env` files, tokens or credentials; use the environment the harness provides. PreToolUse hooks enforce this; the
  rule stands without them.

## Stop conditions

- Stop after 8 implement-test cycles, or after 3 cycles that fail the same way; reflect before each retry.
- Stop at the issue's turn cap (default 80) or wall-clock cap (default 90 minutes). Report what you tried.
- On a subscription usage limit: commit, write a checkpoint to `PROGRESS.md` in the worktree, release the lease and
  stop; the launcher backs off and resumes the session.
- Every stop leaves the branch pushed, the draft PR's body current and the issue Blocked (or handed back to Todo)
  with a note saying why. Nothing waits on Rob.

## For Rob to confirm

- On finishing an issue, write `for-rob/<ISSUE-ID>.md`: the issue ID and title; what changed, in user terms; the
  exact steps to test it in the app with the expected result; the risk flags (CrankHarness `risk.md`); links to the
  PR and the run evidence.
- The merge agent compiles the fragments into `FOR_ROB_TO_CONFIRM.md` at the repository root, grouped by project, one
  checkbox each, the newest wave last.
- Rob is never a dependency: never wait on the file; an unchecked item blocks nothing, not work, not a merge, not
  Done. His findings come back as new issues.

## Done

- An issue is Done when every line of the issue-level definition of done is true (CrankHarness `dod/issue.md`):
  tests first, coverage held, the local gate and PR CI green, the fresh-context evaluator PASS, the cross-model review
  clean, risk scored and flagged, the diff inside Touches, no secrets, merged through the queue without force-push,
  the run folder linked, the for-rob entry written. A line no gate can prove yet is reported in the PR as "not yet
  provable: <issue>", never as passed.
- The merge agent merges and moves the issue to Done. No human approves an individual merge or issue. High-risk work
  (auth and security, secrets and config, migrations and schema, destructive, payments, infra and CI, broad
  refactors) is flagged `risk:high`, never blocked (Rob, Nov 2, 2026).
- The work is reviewed once, with the rest of its project, at project completion (CrankHarness `dod/project.md`).
