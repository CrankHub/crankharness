# The autonomy proof

ROB-524. The harness is finished when both runs below pass. Each is a run, not a review: a fixture project is
handed to the orchestrator, nobody touches it, and the evidence either shows every item or the proof fails and
names what was missing.

## Two runs, and what each can show

| Run | Providers | Shows | Cannot show |
| --- | --- | --- | --- |
| **The fault run** | scripted fake providers, behind the real adapter interface | that the loop closes and survives every planted fault, the same way every time | anything about a real provider |
| **The live run** | every real provider the owner uses, on subscription logins | that Claude Code, Codex and Grok each do the job through the adapter, and judge each other | faults that cannot be forced on a real tool |

The live run needs all three providers. If a provider's tool cannot do the job (`PROVIDERS.md`), the live run
passes only with the owner's recorded decision that the requirement is reduced, naming the provider and the missing
capability. It is never quietly dropped.

## The fixture

A small repository and tracker project made for the proof: twelve issues in a dependency graph, two lanes of files,
one true interface between the lanes, one milestone with a check command, a goal file with three checks, and a
contract that passes. The work is trivial on purpose. The proof is of the loop.

## The fault run: what is planted and what must be observed

| # | Planted | Must be observed | Proves |
| --- | --- | --- | --- |
| 1 | two fake providers | work written by each is judged by the other; no verdict is written by a worker | collaborative |
| 2 | an issue whose first attempt fails a criterion | NEEDS_WORK, fixed by its worker, PASS on round two | QA'd |
| 3 | a change that passes the gate but fails an acceptance criterion | NEEDS_WORK; a run where it merges fails the proof | the evaluator is not a rubber stamp |
| 4 | a change that meets its criteria and works against a named goal check | NEEDS_WORK naming the check | goal-oriented |
| 5 | a worker that never satisfies the evaluator | Blocked after `caps.rounds`, in the for-rob file, and the rest of the run carries on | no livelock |
| 6 | an interface-first producer and its consumer | the consumer is opened after the interface merges and before the producer is Done | collaborative |
| 7 | two issues with overlapping Touches | never In Progress together | mergeable |
| 8 | a provider at its usage limit mid-issue | another provider resumes from the checkpoint and finishes | autonomous |
| 9 | a provider that is signed out | routed around; reported in the for-rob file; nothing waits | autonomous |
| 10 | a decision file added mid-run | one issue corrected (STALE), one canceled (OBSOLETE, its worker stopped), one **new issue written, validated by a separate session, built and merged** | things change; new assignments |
| 11 | an issue naming a file that no longer exists | caught at validation, corrected before any worker starts | validation is real |
| 12 | a merge that passes its branch gate and breaks main | reverted, returned to its worker; main is never red at the end of a poll | tested |
| 13 | a main gate that fails once and passes on re-run | not reverted | no false reverts |
| 14 | a commit pushed to a branch after its PASS | the PASS is void and the commit is re-evaluated | the verdict is bound to a commit |
| 15 | the orchestrator killed between landing a merge and writing the main-gate status | the supervisor restarts it; the successor runs the gate on that commit and finishes; exactly one merge | crash recovery |
| 16 | the orchestrator paused past its lease expiry, a second one started, the first resumed | the first writes nothing; one lease, one epoch in every write after take-over | one orchestrator |
| 17 | a second orchestrator started while the first is healthy | it exits naming the holder | one orchestrator |
| 18 | nothing | every eligible issue (validated, no Touches overlap, room under the limit) is dispatched within one poll of its last blocker merging | auto pick-up |
| 19 | a milestone whose check command fails | the command is run on main, the evidence attached, and one issue filed per failure | goal-oriented |
| 20 | nothing | at the end, every issue is Done, Blocked or Canceled, each with its ledger | closure |

## The live run: what must be observed

Items 1, 2, 3, 6, 8, 14, 18 and 20, with real providers (for item 8 a worker is stopped by the harness mid-issue
and a worker of another provider resumes from the checkpoint), plus: each provider wrote at least one merged change and judged at
least one; every worker, of every provider, was held to its Touches, its wall-time cap and the secret scan.

## Pass and fail

- Each run has a time limit set in the fixture. Running past it is a failure.
- "Nobody touched it" is checked from the actors on every commit, status, tracker change and comment: all must be
  the harness's App or a provider's worker identity. A self-reported list is not evidence.
- The report gives, per issue: author provider and model, evaluator provider and model, rounds, time; and for the
  run: first-pass PASS rate, reverts, time from a merge to the next dispatch, stale rate.
- Any item not observed fails the proof and is named.

## What the proof does not show

That the work is good on a real project. That is what a real project's goal file, its milestone checks and the one
human review are for (ROB-420, ROB-418).

## Before the proof exists

A project at stage 0 or 1 keeps a hand version: the orchestrator session notes on its ledger each item it sees
happen in real work. It is weaker evidence, and the ledger says so.
