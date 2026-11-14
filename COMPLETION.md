# What finished means for the harness

Rob, Nov 14, 2026: the harness must result in autonomous, collaborative work across AI platforms, with
goal-oriented, tested and evaluated results, automatic pick-up of the next task, and a single orchestrator managing
the merge queue; and that orchestrator must hand out new assignments and validate tasks as things change. This page
says what each of those requires, which issue delivers it, in what order, and how anyone can tell it is true. It is
the instruction for every session that builds the harness.

**Finished is stage 3:** both runs of the autonomy proof pass unattended (`PROOF.md`, ROB-524). Stage 4 is what a
real project needs around that.

## The requirements

| Rob's requirement | What must be true | Delivered by | Fails the proof if missing |
| --- | --- | --- | --- |
| **Autonomous** | An issue goes from ready to Done with no person: dispatched, built, gated, judged, merged, closed. A stopped worker is resumed from its checkpoint. A dead orchestrator is restarted by its supervisor and reconciles. | ROB-404, ROB-405, ROB-408 (with its supervisor), ROB-411, ROB-412, ROB-521 | items 8, 9, 15, 18, 20 |
| **Collaborative across AI platforms** | Claude, GPT and Grok do the same job through one adapter, are fenced the same way, resume each other's work and judge each other's work. | ROB-403, ROB-516, ROB-517, ROB-518, ROB-523 | items 1, 6, 7, 8 and the live run |
| **Goal-oriented** | Every issue names the goal check it serves; the evaluator judges against it; each milestone has a command that is run on main. | ROB-522, ROB-520 | items 4, 19 |
| **QA'd and tested** | Tests first; the gate run by the harness on the branch and again on main; a verdict from a fresh session of another provider, bound to the exact commit; a cap on rounds; a breaking merge reverted; a review agent and a coverage check. | ROB-405, ROB-406, ROB-518, ROB-523, ROB-413, ROB-414 | items 2, 3, 5, 12, 13, 14 |
| **Auto pick-up of the next task** | When a merge lands, what it unblocked is validated, marked ready and dispatched by rule. | ROB-519, ROB-520, ROB-408 | item 18 |
| **A singular orchestrator managing the merge queue** | One lease per project, taken by compare-and-swap, with an epoch that fences every write. One merge at a time. Only the harness's GitHub App lands on main. | ROB-521, ROB-398, ROB-399, ROB-412 | items 15, 16, 17 |
| **New assignments and task validation as things change** | A recorded decision reaches every open issue and merged change it touches; stale issues are corrected, obsolete ones canceled, missing ones written and themselves validated. | ROB-520, ROB-519, ROB-517 | items 10, 11 |

## What changed on Nov 14

The plan of Nov 2 was written with one provider in mind and with Rob setting `agent-ready` by hand. Nine issues
close the gap (ROB-516 to ROB-524). Two Nov 2 decisions change, and only for a project that opts in:

- **Who sets `agent-ready`.** A project may set `ready.by` to `orchestrator-session` or `harness`.
- **Nothing else.** In particular risk is still flagged and never blocks (`risk.md`): a same-provider evaluation
  is marked and reported, not held.

| Issue | Adds |
| --- | --- |
| ROB-516 | provider adapters: one worker interface, tool-independent fences, the checkpoint |
| ROB-517 | routing by provider and tier, with failover |
| ROB-518 | the evaluator: another provider, a verdict the harness writes on the exact commit, a cap on rounds |
| ROB-519 | the planner: ready by rule, next task picked up automatically |
| ROB-520 | task validation and change control |
| ROB-521 | one orchestrator: the lease, fencing, the supervisor, reconcile after a crash |
| ROB-522 | the goal file, milestone commands, and the issue template's new fields (contract 2) |
| ROB-523 | hand-back and seams as harness templates |
| ROB-524 | the autonomy proof: a fault run and a live run |

## The stages

Each stage ends in something usable, so a project can start before the harness is finished and move up without
changing the rules its workers follow. A project's own plan cites these stages by number and does not keep its own
list of harness issues.

| Stage | What exists | A project at this stage | Issues, in order |
| --- | --- | --- | --- |
| **0. By hand** | the contract and its check | person-started sessions follow the project's `AGENTS.md`; a person-started orchestrator session merges (`ORCHESTRATOR.md`, "By hand") | ROB-400 (done in substance), ROB-402 |
| **1. Dispatched** | one command turns an issue into a gated, judged draft pull request on any provider | the orchestrator session runs dispatch per issue; it still merges | ROB-403; ROB-516's interface, then ROB-404 against it; ROB-405; ROB-406; the rest of ROB-516; ROB-399 (the GitHub App, which alone writes verdicts); ROB-518; ROB-522; ROB-523; then ROB-407 (ten measured dispatches) |
| **2. Unattended** | the supervised orchestrator process | nothing is started by hand | ROB-397, ROB-398; ROB-410 (run folders); ROB-408; ROB-411; ROB-412; ROB-521; ROB-517; ROB-519; ROB-520; ROB-413; ROB-414; ROB-417 |
| **3. Proven: finished** | both proof runs pass | concurrency above three while the PASS and revert rates hold | ROB-524, then ROB-420 |
| **4. Around it** | evidence bundle, release step, the first project review, a second tracker | the one human review per project | ROB-416, ROB-415, ROB-418, ROB-419 |

ROB-401 (a verify skill) is a project's own work, not a harness stage: each project builds its own.

ROB-404, ROB-405 and ROB-406 are In Progress. ROB-404 should take ROB-516's adapter interface before it goes
further.

## Things to verify early, because the plan leans on them

1. **The merge queue.** GitHub's merge queue is not available on every plan for a private repository. ROB-398
   checks it for each project. Where there is none, "the queue" is the orchestrator's own serial merge by
   fast-forward push under a ruleset that lets only the App push. `ORCHESTRATOR.md` is written to work either way.
2. **Each provider's tool** (`PROVIDERS.md`): headless, a model name, fresh sessions. Codex and Grok are shown to
   reach the tracker and GitHub (Rob, Nov 14, 2026); the rest is unshown for both.
3. **Subscription logins lapse** and need a person to renew. This is a known, permanent human touchpoint. The
   harness routes around a signed-out provider and reports it; with all providers signed out, it stops and says so.
4. **Where the orchestrator runs:** an always-on machine holding the three logins, with a supervisor.
5. **CI.** A project whose repository has no workflow cannot prove "the same checks pass in PR CI". It reports that
   line as not yet provable until it has one.
6. **Fencing on GitHub's merge queue.** The lease's fast-forward guarantee holds only where the orchestrator lands
   changes itself. On the queue path, confirm that adding an already-merged or already-queued pull request is a
   no-op, and plant a stale holder on that path in the proof.
7. **Who may write `refs/harness/*`.** A ruleset must keep it to the harness's App.
8. **Polling by person-started sessions.** At stage 0 a session must re-check the tracker on a timer. Nothing has
   shown that every provider's tool can.

## Known stale, to be swept under ROB-522 and ROB-523

`templates/AGENTS.sections.md` still tells a worker to write its checkpoint to `PROGRESS.md` at a usage limit; the
checkpoint is now `.harness/progress/<ISSUE-ID>.md`, kept current with every commit (`PROVIDERS.md`).
`templates/issue.md` still lists `agent-ready` as a label an author sets and lacks the Serves, Produces and Consumes
lines. `risk.md` still puts risk-list proposals in `PROGRESS.md`; they belong in the hand-back file. `dod/issue.md`
speaks of phases 0 to 3: phase 0 is stage 0, phase 1 is stage 1, phases 2 and 3 are stage 2.

## The order of merging

When more than one pull request has a PASS: interface pull requests first; then the issue more others wait on;
then the oldest.

## The five measures

Kept on each project's ledger, and they are how a project knows the harness is working for it: first-pass PASS
rate per provider; reverts; stale rate at validation; wait from a merge to the next dispatch; the owner's
interventions, each turned into a rule, a test or a template line.

## Rules for building the harness itself

1. The harness is built under its own contract, by hand until stage 1 exists, with a fresh-context evaluator from
   another provider wherever one is available.
2. Every part is tested against a fake provider and a fixture tracker before it touches a real project.
3. Nothing in this repository names a project's private details. It is public.
4. No API keys, anywhere. Subscription logins only.
5. A part that cannot yet prove its definition-of-done line says "not yet provable" and names the issue.
6. What is unknown is written down as unknown.

## See also

`ORCHESTRATOR.md`, `PROVIDERS.md`, `PROOF.md`, `CONTRACT.md` (including "Contract 2", the keys these parts add).
