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
| 1 | CMD-21 (project-cmd): harvest the engine from CrankMagic by script | claude-opus-5-5 (tier A asks claude-fable-5-2) | 7 in two attempts: 5 (stopped), then 2 | Gate FAIL (attempt 1). First evaluator verdict NEEDS_WORK, then PASS. | 1. Dispatch never gave the evaluator the issue or the test results. 2. The tier A model needs a newer Claude Code; ran Opus 5.5. 3. The same gate failure looked new each cycle (test timings), in dispatch and in the Stop hook. 4. Dispatch does not push on a stop; pushed and opened the PR by hand. 5. **Rob** widened CMD-21's Touches to the project's gate, so the worker could fix its secret scan. 6. A resumed run would have failed on the PR already open. 7. The evaluator's Touches check refused folders written as `engine/` and the worker's `for-rob/` file. 8. The PR body was 815 KB, over GitHub's limit; set by hand. | 1. A test. 2. Nothing yet (follow-up A). 3. Two tests. 4. Nothing yet (follow-up B). 5. A CI check: the worker's fix to the project's secret scan, which now also catches a key shape it missed. 6. A test. 7. Two tests. 8. A test. | [project-cmd#15](https://github.com/CrankHub/project-cmd/pull/15) (merged Nov 20) |
| 2 | CMD-62 (project-cmd): three candidate looks for the world, one chosen | Codex, gpt-6.1-sol (its config default; the project's GPT tiers are unset). Judged by Claude. | 1 | NEEDS_WORK (Rob, Nov 21: the recheck counts). The run's own PASS came from an evaluator whose Touches check was not running. | 1. `--provider gpt` was refused: the project says gpt, the harness said codex. 2. The evaluator would have judged Codex's work with Codex; the project asks for Claude. 3. The dispatch could not read Codex's output (no summary, turns or usage). 4. Main moved during the run (CMD-33 merged), and the PR body showed CMD-33's files as deleted here. Body corrected by hand. 5. The evaluator's Touches check had silently never run, in this dispatch or in dispatch 1: it read Touches only as a list, and both issues write it on one line. Fixed, and the evaluator run again by hand. | 1. A test. 2. A test (closes follow-up F). 3. A test. 4. A test. 5. A test. | [project-cmd#31](https://github.com/CrankHub/project-cmd/pull/31) (draft; Rob merges) |

First-pass PASS rate so far: 0 of 2. Interventions: 13, one by Rob. Turned into a rule: 11 of 13 (tests in this
repository, plus one CI check in the project). Two are follow-ups (A, B).

## Dispatch 1: CMD-21, Nov 18 and 19, 2026

- **Command:** `node dispatch/dispatch.mjs --repo <project-cmd> --issue CMD-21 --issue-file <issue file> --provider claude --model claude-opus-5-5`,
  after a `--dry-run` each time. The issue file was written from the Linear issue into the run folder, outside
  both repositories.
- **Attempt 1 (Nov 18, 14 minutes, 5 cycles, stopped at the turn cap):** the worker wrote the harvest script, the
  copy (about 13,000 files from one CrankMagic commit, with a manifest), the two deck lists, the whole-game test
  and `for-rob/CMD-21.md`. All three tests passed. The gate did not: its secret scan matched inside one card's
  file name, which the manifest has to list. The gate is shared ground in that project, so the worker stopped and
  proposed the one-line fix. That was the right call.
- **Rob's decision:** widen CMD-21's Touches to the gate, for the secret-scan pattern only.
- **Attempt 2 (Nov 19, 33 minutes, 2 cycles):** the run resumed the same worktree. Cycle 1: the worker fixed the
  pattern, the gate passed, and the evaluator said NEEDS_WORK because no test ran the harvest script itself
  (running it twice, the refusals, a missing deck). Cycle 2: the worker added four fixture tests and fixed a bug
  they found. The gate passed with 7 tests and the evaluator said PASS. The push worked. Updating the PR body
  failed: see intervention 8.
- **What the run showed about the harness:**
  - The evaluator earned its place. The gate was green, and it still found the script's own behavior untested.
  - The evaluator, the dispatch and the hooks did not agree on what Touches means. Three seams, each fine alone,
    each tested against fakes that agreed with themselves. Two of the three bugs were found by running the real
    evaluator's check against the real branch before the second attempt. Rule: before a real run, run each part's
    check against the real branch.
  - The same-failure cap did not work: test output carries timings, and both the dispatch and the Stop hook counted
    every timing change as a new failure. Cycles 2 to 5 of attempt 1 were wasted.
  - The worker had no way to say "I am blocked". It said so in plain words, and the dispatch ran it again four
    times (follow-up C).
  - GitHub's error for an oversized PR body is "GraphQL: Something went wrong", which says nothing about size.
  - The hooks refused `handback/CMD-21.md`, a file that project's rules give to the worker (follow-up D).
  - A refusal also fired on the worker's own scratch file in the OS temp folder, written by a Bash `cat >` with a
    `/c/Users/...` path. The temp folder is meant to be writable (follow-up E).
  - The evaluator ran on Claude, the same provider as the worker (follow-up F).
  - The project's own `.claude/settings.json` allow rules were ignored because the worktree folder was never
    trusted. Harmless here (the dispatch passes its own allowed tools). Worth knowing.

## Dispatch 2: CMD-62, Nov 21, 2026

- **Why this issue:** project-cmd's own sessions finished the Claude issues that opened after CMD-21 (CMD-22,
  CMD-27, CMD-28, CMD-71, CMD-75) outside the harness. The only issues still ready were GPT design issues, and
  Rob picked CMD-62 on GPT. It was the first real run of the Codex worker.
- **Command:** `node dispatch/dispatch.mjs --repo <project-cmd> --issue CMD-62 --issue-file <issue file> --provider gpt`,
  after a `--dry-run`. No `--model`: the project's GPT tiers are `unset`, so Codex used its own default.
- **The run (45 minutes, 1 cycle):** Codex worked for 31 minutes in 74 steps. It drew the three looks as SVG
  from a script, rendered them in a headless browser, chose look A, and wrote the README table, `for-rob/CMD-62.md`
  and `handback/CMD-62.md`. Its sandbox refused its own `git commit` (the worktree's git folder is outside the
  sandbox), so the dispatch committed the files. The gate passed, Claude's evaluator said PASS, and the draft PR
  opened.
- **The verdict:** NEEDS_WORK. Rob ruled on Nov 21 that the recheck counts, because the run's own PASS came from
  an evaluator whose Touches check was not running.
- **The recheck:** after the run, I found that the evaluator's Touches check had never run, in either dispatch.
  For dispatch 1 it would have found nothing: its branch was checked by hand before the second attempt. Run again
  on CMD-62 with the check working, the evaluator said NEEDS_WORK on two points:
  - `handback/CMD-62.md` is outside the Touches. The project gives that file to the worker, so this is
    follow-up D, not the worker's fault.
  - "Verification gap": no test checks the pictures, only the worker's own account. The first run judged the same
    evidence as met. The issue's own Verification asks for nothing more than is there.
- **What the run showed about the harness:**
  - The Codex path works end to end on a subscription login: no keys, one cycle, a draft PR.
  - Each part needs the project's names. The project says gpt, the harness said codex, and three places had to
    learn it.
  - An evaluator's verdict on a judgment point is not reproducible from one run (follow-up G).
  - The hooks are Claude Code settings. They did not fence the Codex worker; its sandbox did (follow-up H).
  - Main moves while a worker runs. Every comparison must be against where the branch left main.

## Follow-ups the dispatches found

- **A. The model tier.** Dispatch does not read `providers.<name>.tiers` from `WORKFLOW.md`, and it does not check
  that the installed CLI can run the model. Tier A for Claude in project-cmd needs Claude Code 2.1.290 or newer.
  The hooks were proven on 2.1.282, so updating means proving them again.
- **B. Push on a stop.** project-cmd's `AGENTS.md` asks that every stop leaves the branch pushed, a draft PR open
  and the issue Blocked. Dispatch stops without pushing. Proposed: on a stop with commits, push and open the draft
  PR with the stop reason in its body.
- **C. A blocked signal.** A worker that cannot go on should be able to say so (a line in its progress file, or a
  marker file), and dispatch should stop at once instead of running it again.
- **D. The worker's own files.** The hooks and the evaluator allow `PROGRESS.md`, `for-rob/**` and new tests
  outside Touches. A project's hand-back file is the worker's too. Either both read a list of the worker's own
  files from `WORKFLOW.md`, or the issue template puts them in Touches. Dispatch 2 hit it: the recheck failed
  CMD-62 on `handback/CMD-62.md`.
- **E. Temp-folder writes from Bash.** Check the `outside-touches` rule against MSYS-style paths (`/c/Users/...`)
  under the OS temp folder.
- **F. The evaluator's provider.** Done in dispatch 2: dispatch follows `WORKFLOW.md` `providers.evaluate`, and
  `--evaluator` overrides.
- **G. One verdict is one sample.** The same branch and evidence got PASS, then NEEDS_WORK on "verification gap".
  Options: run the evaluator twice and take NEEDS_WORK when they disagree, or say in the issue template what
  verification a picture or document issue needs.
- **H. A fence for Codex.** The hooks are Claude Code settings. Codex has hooks of its own; until they are wired,
  a Codex worker is held by its sandbox, the gate and the evaluator's Touches check only.

## Next dispatches (3 to 10)

Not started: Rob chooses. project-cmd's own sessions take its Claude issues as they open, so the next ones need
the project's orchestrator (CMD-65) to set an issue aside for the harness.

## Risk list proposal

None from dispatch 1.
