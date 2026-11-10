---
harness: crankharness
contract: 1
project: <owner/name>
tracker:
  kind: linear
  team: <team key>
  ready_label: agent-ready
  states:
    todo: Todo
    in_progress: In Progress
    blocked: Blocked
    done: Done
concurrency: 3
branch:
  pattern: agent/<ISSUE-ID>-<slug>
gate:
  local: <the command a worker runs before every push>
touches:
  default: <lane | none | a path list>
verify:
  skill: <path to the verify skill's SKILL.md>
  feature_map: <path to its feature map>
  pending: <ISSUE-KEY, only while the two files above do not exist yet>
caps:
  cycles: 8
  same_failure: 3
  turns: 80
  wall_minutes: 90
---

# How the harness runs this project

The front matter above is the runtime policy the CrankHarness daemon reads (`CONTRACT.md`, part 3); the prose below is
for the worker it dispatches. Keep the keys; change the values to the project's own.

## States

The daemon dispatches an issue in **Todo** labeled `agent-ready` whose blockers are all merged, sets it **In
Progress** when a worker holds it, **Blocked** when a stop condition is hit (with a note), and **Done** when the
issue-level definition of done is true and the merge agent has merged.

## Concurrency

At most `concurrency` sessions at once in this project; raised only while the first-pass PASS rate and the post-merge
revert rate hold.

## The lease

An issue's Touches are its lease: nobody else edits those files while it is In Progress. When an issue lists no
Touches, `touches.default` says what the lease is.

## The branch and the gate

A worker gets its own worktree on `branch.pattern`, merges `origin/main` in to catch up (never a force-push), runs
`gate.local` before every push, and opens a draft PR whose title starts with the issue key.

## Verification

`verify.skill` runs the application the way a user would and `verify.feature_map` says how to reach each feature.
While `verify.pending` names an issue, only issues whose verification is a test suite are dispatched.
