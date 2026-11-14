# The orchestrator

There is exactly one orchestrator per project. It is the only thing that decides an issue is ready, assigns it,
merges it, and marks it Done. Workers and evaluators come and go; the orchestrator is the continuity.

At stage 0 and 1 (`COMPLETION.md`) the orchestrator is a session a person starts and it follows this page by hand.
From stage 2 it is a process: the daemon (ROB-408), the planner (ROB-519), the validator (ROB-520), the router
(ROB-517) and the merge agent (ROB-412) under one lease (ROB-521). The duties are the same at every stage.

## The loop

Every poll, in this order:

1. **Hold the lease.** Renew the heartbeat. If the lease is not yours, exit.
2. **Read the world from the tracker and GitHub only.** What is In Progress, In Review, Blocked, queued, merged.
   The orchestrator keeps no state of its own that cannot be rebuilt from those two.
3. **Take hand-backs.** For each issue In Review: start an evaluator on another provider if it has no verdict
   (ROB-518); on NEEDS_WORK return it to its worker with the findings; on PASS put it in the merge queue.
4. **Merge, one at a time.** Merge main into the branch, run the gate, check the diff against the Touches lease,
   land it through the queue, run the gate on main. If main fails, revert that merge and return the issue. Then,
   and only then, mark the issue Done.
5. **Plan.** For each issue the merge unblocked: check its blockers, lint its spec, check its Touches against
   everything in flight, check the seam it consumes is merged, and validate it (below). Mark it ready or say on the
   issue why not.
6. **Assign.** Order the ready issues (interfaces first, then the most waited-on, then the oldest) and dispatch
   while there is room under the concurrency limit, each to a provider and a tier (`PROVIDERS.md`).
7. **Tend what is stuck.** Resume a worker stopped at a usage limit, on another provider if need be. Read each
   Blocked issue: answer it, split it, raise a contract issue, or put it in the for-rob file and move on.
8. **Check the goal.** When a milestone's last issue is Done, run its integration check on main and file what fails
   (ROB-522).
9. **Keep the books.** The for-rob file, the run folders, a status on the orchestrator's issue.

## Validating a task

An issue is a claim about the project made on the day it was written. Before a worker spends a session on it, the
orchestrator checks the claim against today, in a fresh session with no write tools:

| Question | If not |
| --- | --- |
| Do the files, functions and seams it names exist on main? | STALE: correct the names and paths |
| Does it agree with every decision recorded since it was written? | STALE: propose the edit; a person or a planner session accepts it |
| Is it still undone? | OBSOLETE: cancel it with the reason; re-check what it blocked |
| Does it serve a check in the goal file, or enable an issue that does? | STALE: name the check, or OBSOLETE |
| Is each acceptance criterion testable, and is the verification runnable by a worker with the tools the project has? | STALE: rewrite the criterion |
| Are its Touches narrow enough not to overlap its neighbours? | STALE: narrow them |

The verdict, the date and the commit of main it was checked against go on the issue. An issue validated against the
current main is not validated again.

## When things change

Plans change. The orchestrator is where a change is made to reach everything it touches.

1. **A change arrives** as a decision recorded in the project's decisions path, an issue closed with the `decision`
   label, a finding from a milestone check, or a `from-rob` issue.
2. **Find what it touches.** List the open issues whose goal checks, files, seams or blockers the change affects.
3. **Re-validate each.** VALID stays as it is. STALE gets its proposed edit. OBSOLETE is canceled.
4. **Write what is now missing** as new issues, complete specs, in Backlog. The orchestrator may write them itself
   in a tier-A planning session, or ask the provider that owns the lane.
5. **Re-plan.** Blockers change; re-run step 5 of the loop.
6. **Work in flight is not stopped.** A worker whose issue went STALE is told on the issue. It finishes or stops by
   its own stop conditions, and the evaluator judges against the corrected issue.
7. **Say what changed** on the orchestrator's issue: the change, the issues edited, canceled and created.

The orchestrator never changes a project's goal file or its rules file. A change to either is a decision, made by
the project's owner, and arrives by step 1.

## Assigning work

- The provider comes from the issue's `provider:` label; the tier from its `tier:` label or the default rule
  (`PROVIDERS.md`).
- An issue moves to another provider when its own is unavailable, at its usage limit, or has failed it twice. The
  label changes and the reason is on the issue.
- The orchestrator balances: no provider holds more than its share of the concurrency limit while another has ready
  work and room.
- The evaluator is never the author's provider.

## What the orchestrator never does

- Write feature code, or fix a worker's branch.
- Merge without a PASS from a fresh-context evaluator, or more than one pull request at a time.
- Leave main red.
- Spend money, deploy to production outside the project's release rule, or publish.
- Wait on a person. A question for the owner goes in the for-rob file and the loop continues.
- Run twice. There is one lease.

## What a project provides for it

In `WORKFLOW.md` (`CONTRACT.md`): the tracker and its states including `in_review`; `concurrency`; `ready.by`
(`harness` or `human`); the `providers` section; `shared_files`; the `goal.file` and the milestones; the `decisions`
path. In the tracker: one standing issue the orchestrator reports on.
