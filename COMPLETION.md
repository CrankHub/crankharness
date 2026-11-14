# What finished means for the harness

Rob, Nov 14, 2026: the harness must result in autonomous, collaborative work across AI platforms, with
goal-oriented, tested and evaluated results, automatic pick-up of the next task, and a single orchestrator managing
the merge queue. This page says what each of those words requires, which issue delivers it, in what order, and how
anyone can tell it is true. It is the instruction for every session that builds the harness.

The harness is not finished when its parts exist. It is finished when the autonomy proof (`PROOF.md`, ROB-524)
passes unattended.

## The six requirements

| Rob's requirement | What must be true | Delivered by | Proved by |
| --- | --- | --- | --- |
| **Autonomous** | An issue goes from ready to Done with no person and no prompt: dispatched, built, gated, evaluated, merged, closed. A stopped worker is resumed; a crashed orchestrator is replaced. | ROB-404 dispatch, ROB-405 hooks, ROB-408 daemon, ROB-411 resume, ROB-412 merge agent, ROB-521 the lease | proof items 5, 8, 9 |
| **Collaborative across AI platforms** | Claude, Codex and Grok do the same job through the same interface, hand work to each other, and judge each other's work. No provider has its own process. | ROB-403 logins, ROB-516 adapters, ROB-517 routing, ROB-518 cross-provider evaluator, ROB-523 hand-back and seams | proof items 1, 3, 4, 5 |
| **Goal-oriented** | Every issue serves a named check in the project's goal file; the evaluator judges against it; each milestone is run on main. Work that passes its tests and misses the goal is NEEDS_WORK. | ROB-522 goal file and milestones, ROB-520 validation | proof items 6, 10 |
| **QA'd and tested** | Tests first from the acceptance criteria; the gate before every push and again in CI; a fresh-context verdict from another provider; coverage held; risk flagged; a merge that breaks main is reverted. | ROB-405, ROB-406, ROB-413, ROB-414, ROB-518, ROB-523, ROB-401 (the verify skill) | proof items 2, 7; the definition of done |
| **Auto pick-up of the next task** | When a merge lands, what it unblocked is validated, marked ready and dispatched by rule. Nobody sets a label by hand. | ROB-519 the planner, ROB-520 validation, ROB-408 | proof item 9 |
| **A singular orchestrator managing the merge queue** | One lease per project. Only its holder decides readiness, assigns work and merges, one merge at a time, through one queue that only the harness's GitHub App may land. | ROB-521, ROB-398 rulesets and queue, ROB-399 GitHub App, ROB-412 | proof item 8 |

## What changed on Nov 14

The plan of Nov 2 was written with one provider in mind and with Rob setting `agent-ready` by hand. Nine issues
close the gap. None of the Nov 2 decisions is reversed except that one: a project may now set `ready.by: harness`.

| Issue | Adds |
| --- | --- |
| ROB-516 | provider adapters: one worker interface for Claude Code, Codex and Grok |
| ROB-517 | routing by provider and model tier, with failover at a usage limit |
| ROB-518 | the evaluator is never the author's provider, enforced |
| ROB-519 | the planner: ready by rule, next task picked up automatically |
| ROB-520 | task validation and change control |
| ROB-521 | one orchestrator: lease, heartbeat, take-over |
| ROB-522 | the goal file and milestone checks (contract part 5) |
| ROB-523 | hand-back and seams as harness templates |
| ROB-524 | the autonomy proof |

## The order

Each stage ends in something that can be used, so a project can start before the harness is finished and move up a
stage without changing its rules.

| Stage | What exists | A project at this stage runs | Issues |
| --- | --- | --- | --- |
| **0. By hand** | the contract and its check | sessions started by a person follow `AGENTS.md`; a person-started orchestrator session merges | ROB-400 (done in substance), ROB-402 |
| **1. Dispatched** | one command turns an issue into a gated, evaluated draft pull request, on any provider | a person (or the orchestrator session) runs dispatch per issue; merging is still by the orchestrator session | ROB-403, ROB-404, ROB-405, ROB-406, ROB-516, ROB-518, ROB-523, ROB-522, then ROB-407 (ten measured dispatches) |
| **2. Unattended** | the daemon, the planner, validation, routing, the merge agent and the lease | nothing is started by hand; the orchestrator is a process | ROB-397, ROB-398, ROB-399, ROB-408, ROB-411, ROB-412, ROB-517, ROB-519, ROB-520, ROB-521, ROB-410 |
| **3. Proven** | the autonomy proof passes | concurrency above three is allowed while the PASS and revert rates hold | ROB-524, then ROB-420 |
| **4. Complete** | review agent, coverage diff, evidence bundle, for-rob compiler, release step, the first project review | the one human review per project | ROB-413 to ROB-418 |

Within a stage, take issues in blocker order (the tracker holds the relations). Stage 1's first three in order:
ROB-404, ROB-405, ROB-406, which are In Progress.

## Rules for building the harness itself

1. The harness is built under its own contract. Until stage 1 exists it is built by hand under `AGENTS.md` rules,
   with a fresh-context evaluator from another provider wherever one is available.
2. Every harness part is tested against a fake provider and a fixture tracker before it touches a real project.
3. Nothing in this repository names a project's private details. It is public.
4. No API keys, anywhere. Subscription logins only.
5. A part that cannot yet prove its definition-of-done line says "not yet provable" and names the issue. It never
   reports a pass it did not measure.
6. What is unknown is written down as unknown. Today that is chiefly: whether Grok's tool can run headless, take a
   model, start fresh sessions and reach the tracker and GitHub (`PROVIDERS.md`).

## See also

`ORCHESTRATOR.md` (what the one orchestrator does), `PROVIDERS.md` (the adapter interface, tiers, who evaluates
whom), `PROOF.md` (the test of all of it), `CONTRACT.md` (what a project provides).
