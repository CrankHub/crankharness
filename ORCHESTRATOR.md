# The orchestrator

There is exactly one orchestrator per project. It alone decides an issue is ready, assigns it, merges it and marks
it Done. Workers and evaluators come and go; the orchestrator is the continuity.

At stages 0 and 1 (`COMPLETION.md`) it is a session a person starts, following this page by hand. From stage 2 it
is a supervised process: the daemon (ROB-408), planner (ROB-519), validator (ROB-520), router (ROB-517) and merge
agent (ROB-412) under one lease (ROB-521). The duties are the same at every stage; "By hand", at the end, lists the
named exceptions.

## Where its state lives

The orchestrator holds nothing in memory that it cannot rebuild. Everything it knows is in one of four places, and
a successor reads only these:

| What | Where | Written by |
| --- | --- | --- |
| The lease: holder, epoch, expiry | the git ref `refs/harness/lease` in the project repository | the orchestrator, by compare-and-swap |
| An evaluation verdict | a commit status `harness/evaluation` on the evaluated head commit | the harness's GitHub App only |
| The gate result on main after a merge | a commit status `harness/main-gate` on the merge commit | the App only |
| Everything about an issue: state, labels, its ledger (below) | the tracker | the orchestrator; a worker only on its own issue |

**The issue ledger** is one comment the orchestrator keeps on each issue, rewritten in place: validated at which
commit of main and through which decision; provider and tier assigned; evaluation rounds used; failures and
re-assignments; the run folders. Counters live here, never in the process.

**The project ledger** is one comment on the orchestrator's standing issue: lease holder and last heartbeat; the
last decision processed; what is queued; the five measures (`COMPLETION.md`).

## The lease (ROB-521)

- The lease is a small file committed to an orphan commit that `refs/harness/lease` points at: `{holder, epoch,
  expires}`.
- **Taking it** is a push of a new commit to that ref that succeeds only if the ref still points at the commit the
  taker read (a compare-and-swap; git refuses the push otherwise). The epoch goes up by one on every take.
- **Renewing** is the same push by the holder, every poll, moving `expires` forward. The expiry is three polls.
- **A second orchestrator** reads an unexpired lease it does not hold, and exits naming the holder.
- **Take-over:** after expiry, any orchestrator may take it with a compare-and-swap and a higher epoch.
- **Fencing.** A holder that stalled and wakes after a take-over must not finish what it started. Three things
  stop it. It re-reads the lease immediately before every write and stops if the epoch is not its own. Where the
  orchestrator lands changes itself, main only advances by a fast-forward push of a commit whose parent is the
  current main, so a push prepared against an older main is refused by git; where GitHub's merge queue lands them,
  the queue is the serializer and adding a pull request that is already merged or queued does nothing. Every commit
  status, and every ledger comment in the tracker, carries the writer's epoch, and a successor ignores and
  overwrites anything with a lower one; a tracker state change has no epoch, so a successor's reconcile step
  re-derives each issue's state from its pull request and statuses rather than trusting it. A ruleset keeps
  `refs/harness/*` writable only by the harness's App, never by a worker's credentials.
- **Staying up.** The process runs under a supervisor (a system service or scheduled task on an always-on machine
  that holds the subscription logins) which restarts it when it exits. A restart is just a take-over.

## The loop

Every poll, in this order. Before each step that writes, re-read the lease.

1. **Lease.** Renew, or take, or exit.
2. **Reconcile.** Read the four places above and repair anything half-done by a predecessor:
   - a pull request merged to main with no `harness/main-gate` status: run the gate on that commit now, then go to
     step 4c;
   - an issue In Progress whose worker is gone (no live job, no commit for longer than its wall-time cap): resume
     it from its checkpoint, on another provider if need be;
   - an issue In Review with no evaluation status on its head commit: step 3.
3. **Evaluate.** For each issue In Review whose head commit has no verdict: start an evaluator, a fresh session of
   a provider other than the author's (`PROVIDERS.md`). The harness captures the evaluator's answer and writes the
   status itself; no worker or evaluator can write it. NEEDS_WORK: add one to the issue's rounds; if rounds exceed
   `caps.rounds` (3), mark it Blocked and put it in the for-rob file; otherwise return it to its worker.
4. **Merge, one at a time.** Take the oldest PASS in merge order (`COMPLETION.md`):
   a. If the branch is behind main, the merge agent merges main into it. If that merge has conflicts, return the
      issue to its worker; the orchestrator resolves nothing. If it is clean (a merge commit whose two parents are
      the judged commit and main, with no conflicted file), the PASS carries over: the gate is run on the merged
      commit and the harness writes the evaluation status on it, naming the commit that was judged. Any other new
      commit on the branch voids the PASS and the issue goes back to step 3.
   b. Check the diff against the issue's Touches. Land it through the project's merge queue, or, where the
      repository has none, by a fast-forward push to main by the App under a ruleset that lets nothing else push.
   c. Run the gate on the new main and write `harness/main-gate`. If it fails, run it once more; if it fails again,
      revert that merge, return the issue to its worker with the output, and count a revert.
   d. Only now mark the issue Done. For an interface pull request, return the issue to In Progress instead.
5. **Plan.** For each issue the merge unblocked, in a separate session from any that wrote it: check blockers (a
   consumer of an interface-first producer needs only the producer's interface merged), lint the spec, check its
   Touches against everything in flight, and validate it (below). Mark it ready, or write on its ledger why not.
6. **Assign.** Order the ready issues and dispatch while fewer than `concurrency` issues are In Progress, each to
   a provider and tier (`PROVIDERS.md`).
7. **Tend.** Resume workers stopped at a usage limit. Read each Blocked issue: answer it, split it, raise a contract
   issue, or put it in the for-rob file. A provider that is signed out is routed around and reported in the
   for-rob file: signing in again is the one thing only a person can do.
8. **Change.** Process any decision newer than the last one in the project ledger ("When things change").
9. **Goal.** When the last issue of a milestone is Done, run that milestone's check command on main, attach the
   evidence, and file each failure as an issue for the owner of the failing file.
10. **Books.** The project ledger, the for-rob file, the run folders. Records that live in the repository (the
    compiled for-rob file, a decision file the orchestrator writes) land by a records-only change the orchestrator
    makes itself; it is the one kind of change that needs no verdict, because it touches no rule and no product
    file. Anything else the orchestrator changes goes through evaluation like a worker's change.

## Validating a task (ROB-520)

An issue is a claim about the project made on the day it was written. Before it is marked ready, a fresh tier-A
session with no write tools, on a different provider from the one that wrote the issue, checks the claim:

| Question | If not |
| --- | --- |
| Do the files, functions and seams it names exist on main? | STALE, mechanical: the orchestrator corrects names and paths itself |
| Does it agree with every decision newer than the one on its ledger? | STALE, substantive |
| Is it still undone? | OBSOLETE |
| Does it name a goal check it serves, or the issue it enables? | STALE, substantive; OBSOLETE if it serves none |
| Is each acceptance criterion testable, and can a worker on its provider run the verification? | STALE, substantive, or re-assign |
| Are its Touches narrow enough not to overlap its neighbours? | STALE, mechanical |

- **A substantive edit** is written by a tier-A planning session and then validated by a fresh session of another
  provider, exactly like a new issue. No person is needed and none is waited for; the edit and its reason are on
  the issue.
- **The stamp** goes on the ledger: `validated at main <commit>, decisions through <decision id>: VALID`.
- **Re-validation** happens only when a file or seam the issue names has changed on main since that commit, or a
  decision newer than that id exists. Otherwise the stamp stands.
- **A validator that says VALID to everything** is caught by the proof (`PROOF.md`, items 10 and 11) and, in real
  use, by the stale rate: an issue that fails at its worker for a reason validation should have caught counts
  against the validator.

## When things change

1. **A change arrives** as a new file in the project's decisions path (a reversal of an old decision is a new
   file too, never an edit or a comment), an issue closed with the `decision` label, a failed milestone check, or
   a `from-rob` issue. The project ledger records the last one processed, so nothing is processed twice or missed.
2. **Find what it touches:** open issues whose goal checks, files, seams or blockers it affects, and merged work
   it contradicts.
3. **Re-validate each open issue.** VALID stays. STALE is corrected. OBSOLETE is canceled, and if it is In Progress
   its worker is stopped through the adapter and its branch kept.
4. **Write what is now missing** as new issues in Backlog, including one for any merged work that must change.
   An issue the orchestrator writes is linted and validated by a separate session before it can be marked ready,
   like any other.
5. **Re-plan:** fix blockers, then step 5 of the loop.
6. **Work in flight on a STALE issue is not stopped.** Its worker is told on the issue; the evaluator judges
   against the corrected text.
7. **Say what changed** on the project ledger: the decision, and the issues edited, canceled and created.

The orchestrator never changes a project's goal file or rules file. Those belong to the project's owner.

## Assigning work (ROB-517)

- Provider from the issue's `provider:` label; tier from its `tier:` label, else the default rule.
- An issue moves when its provider is unavailable, signed out, at its limit, lacks a capability the issue needs, or
  has failed it twice. Each provider gets an issue at most once after a failure; when all have failed it, it is
  Blocked.
- No provider holds more than its share of the limit while another has ready work and room.
- The evaluator is never the author's session, and is a different provider whenever one is available.

## What it never does

Write feature code or resolve a worker's conflicts. Merge without a verdict on the exact commit, or two pull
requests at once. Leave main red. Spend money or publish. Wait on a person. Run twice.

## By hand (stages 0 and 1)

A person-started orchestrator session follows this page with these named differences, each weaker than the real
thing and each stated on the project ledger:

- **The lease** is a line in the project ledger (holder, started, last check). A session started as orchestrator
  reads it first and stops if another holder checked within the last three polls. This is advisory, not atomic.
- **A worker merges main into its own branch** when asked; the session does not push to a worker's branch.
- **Workers claim their own slot** by moving a ready issue to In Progress, because the session cannot start
  sessions on other providers. Two tools can race; the orchestrator returns the newer claim to Todo.
- **The verdict** at stage 0 is a comment naming the head commit, by an evaluator session; the orchestrator checks
  the commit and the author before trusting it. It is not authenticated. From stage 1 the harness's App writes it
  as a commit status (ROB-399, ROB-518), as described above.
- **A question for the owner** reaches a person, not just a file: the orchestrator also raises it as a tracker
  issue labeled for the owner and assigned to him, which the tracker pushes to his phone. It never waits on the
  answer. This holds at every stage.
- **The main-gate result** is a line in the issue ledger.
- **Staying up** is the session re-checking on a timer, and a person re-pasting its prompt.

Moving from a hand orchestrator to the process happens only with nothing In Progress or In Review, after every
hand-started seed has been told to stop, and the hand session ends before the process starts.

## What a project provides

In `WORKFLOW.md`: tracker states including `in_review`; `concurrency`; `caps` including `rounds`; `ready.by`
(`human`, `orchestrator-session` or `harness`); `providers`; `shared_files`; `goal.file`; `milestones` (each with
its issues and one check command); `decisions`. In the tracker: one standing issue. `CONTRACT.md` lists which of
these the contract check reads today.
