# Progress: ten measured dispatches (ROB-407)

Trust comes from evidence before parallelism. Ten issues go through `dispatch/dispatch.mjs` with Rob merging, and
every time someone has to step in, that becomes a hard rule: a test, a lint rule, a CI check, a template line or an
`AGENTS.md` line. This file holds one row per dispatch. The run records are in each project's
`.harness/runs/<ISSUE-ID>/` (`dispatch.json`, `evaluation.json`) on the machine that ran it.

An intervention is any time a person or a session had to step in: a restart, a hand fix, a changed prompt or
setting, a refused hook worked around, a step done by hand. Rob's own interventions are marked **Rob**.

## The table

| # | Issue | Worker model | Cycles | First-pass verdict | Interventions (what was changed or said) | What each became | PR |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | CMD-21 (project-cmd): harvest the engine from CrankMagic by script | claude-opus-5-5 (tier A asks claude-fable-5-2) | 5, then stopped at the turn cap (81 of 80) | Gate FAIL; evaluator not reached | 1. Dispatch never gave the evaluator the issue or the test results. Fixed before the run. 2. The tier A model needs a newer Claude Code than this machine has. Ran Opus 5.5. 3. The same gate failure looked new each cycle (test timings), so the same-failure cap never fired, in dispatch and in the Stop hook. 4. Dispatch does not push on a stop. Branch pushed and draft PR opened by hand. 5. Pending: the project's gate misreads a card's file name as a secret. Rob or the orchestrator decides who may change the gate. | 1. A test (`tests/dispatch.test.mjs`): the fake evaluator now refuses like the real one. 2. Nothing yet (follow-up A). 3. Two tests (`tests/dispatch.test.mjs`, `tests/hooks-stop.test.mjs`). 4. Nothing yet (follow-up B). 5. Pending Rob. | [project-cmd#15](https://github.com/CrankHub/project-cmd/pull/15) (draft, stopped) |

First-pass PASS rate so far: 0 of 1. Interventions so far: 5 (none by Rob yet). Fixed into rules: 2 of 5.

## Dispatch 1: CMD-21, Nov 18, 2026

- **Command:** `node dispatch/dispatch.mjs --repo <project-cmd> --issue CMD-21 --issue-file <issue file> --provider claude --model claude-opus-5-5`,
  after a `--dry-run` that printed the expected plan. The issue file was written from the Linear issue into the
  run folder, outside both repositories.
- **What the worker did:** the harvest script, the copy (about 13,000 files from one CrankMagic commit, with a
  manifest), the two deck lists, the whole-game test and `for-rob/CMD-21.md`. All three tests pass. Cycle 1 took
  10 minutes and 60 turns. The whole run took 14 minutes.
- **Why it stopped:** step 4 of the project's gate, the secret scan, matches inside one card's file name, which the
  manifest has to list. The gate is shared ground in that project: only an issue that names it in Touches may
  change it. The worker would not edit it, drop the file from the manifest or disguise the name. It stopped and
  proposed the one-line fix. That was the right call.
- **What the run showed about the harness:**
  - The evaluator was never wired to its evidence. Caught by reading before the run, not by the run. It would
    have stopped every dispatch.
  - The same-failure cap is the cheap way out of a stuck run, and it did not work. Test output carries timings,
    and both the dispatch and the Stop hook counted every timing change as a new failure. Cycles 2 to 5 were wasted.
  - The worker had no way to say "I am blocked". It said so in plain words, and the dispatch ran it again four
    times (follow-up C).
  - The hooks refused `handback/CMD-21.md`, a file that project's rules give to the worker (follow-up D).
  - A refusal also fired on the worker's own scratch file in the OS temp folder, written by a Bash `cat >` with a
    `/c/Users/...` path. The temp folder is meant to be writable (follow-up E).
  - The project's own `.claude/settings.json` allow rules were ignored because the worktree folder was never
    trusted. Harmless here (the dispatch passes its own allowed tools). Worth knowing.

## Follow-ups this dispatch found

- **A. The model tier.** Dispatch does not read `providers.<name>.tiers` from `WORKFLOW.md`, and it does not check
  that the installed CLI can run the model. Tier A for Claude in project-cmd needs Claude Code 2.1.290 or newer.
  The hooks were proven on 2.1.282, so updating means proving them again.
- **B. Push on a stop.** project-cmd's `AGENTS.md` asks that every stop leaves the branch pushed, a draft PR open
  and the issue Blocked. Dispatch stops without pushing. Proposed: on a stop with commits, push and open the draft
  PR with the stop reason in its body.
- **C. A blocked signal.** A worker that cannot go on should be able to say so (a line in its progress file, or a
  marker file), and dispatch should stop at once instead of running it again.
- **D. The worker's own files.** The hooks allow `PROGRESS.md`, `for-rob/**` and new tests outside Touches. A
  project's hand-back file is the worker's too. Either the hooks read a list of the worker's own files from
  `WORKFLOW.md`, or the issue template puts them in Touches.
- **E. Temp-folder writes from Bash.** Check the `outside-touches` rule against MSYS-style paths (`/c/Users/...`)
  under the OS temp folder.
- **F. The evaluator's provider.** Dispatch runs the evaluator on the same provider as the worker. project-cmd's
  `WORKFLOW.md` says a Claude worker is judged by GPT first. Codex works on this machine.

## Next dispatches (2 to 10)

Not started: Rob chooses. Candidates are in the ROB-407 report.

## Risk list proposal

None from dispatch 1.
