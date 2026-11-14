# The autonomy proof

ROB-524. The harness is finished when this passes, unattended. It is a run, not a review: a fixture project is
handed to the orchestrator, nobody touches it, and the evidence either shows all ten things below or the proof fails
and names what was missing.

## The fixture

A small repository and a tracker project made for the proof: twelve issues in a dependency graph, two lanes of
files, one seam between the lanes, one milestone with an integration check, a goal file with three checks, and a
contract that passes. The issues are trivial on purpose. The proof is of the loop, not of the work.

Faults are planted so the run meets them: one issue whose first attempt fails a criterion, one pair with overlapping
Touches, one merge that passes its branch gate and breaks main, a provider scripted to report its usage limit, a
decision file that appears mid-run, and a kill of the orchestrator at a fixed point.

## What must be observed

| # | Observed in the evidence | Requirement it proves |
| --- | --- | --- |
| 1 | Work written by at least two providers, each evaluated by the other | collaborative across platforms |
| 2 | A NEEDS_WORK verdict, fixed by its worker, passed on the second round | QA'd |
| 3 | An interface pull request merged before its consumer was opened | collaborative; mergeable |
| 4 | Two issues with overlapping Touches never In Progress together | mergeable |
| 5 | A provider at its usage limit mid-issue; another provider finishes it | autonomous; collaborative |
| 6 | A decision recorded mid-run makes one issue STALE and one OBSOLETE; both handled | goal-oriented; things change |
| 7 | A merge that breaks main is reverted and the issue returned | tested |
| 8 | The orchestrator is killed; a successor takes the lease; no merge lost or repeated | one orchestrator |
| 9 | Every next issue dispatched within one poll of its blocker merging | auto pick-up |
| 10 | The milestone check run on main, its evidence attached | goal-oriented |

## The report

Per issue: who wrote it, on which model, who judged it, how many rounds, how long. For the run: first-pass PASS
rate, reverts, time from a merge to the next dispatch, and a list of every moment a person would have been needed.
The target for that list is empty.

## What the proof does not show

That the work is good on a real project. That is what a real project's goal file, milestones and one human review
are for (ROB-420, ROB-418). The proof shows only that the loop closes by itself.

## Before the proof exists

A project at stage 0 or 1 can run a hand version: the same ten observations, collected by the orchestrator session
over the project's first two waves and written on its standing issue. It is weaker evidence, and it says so.
