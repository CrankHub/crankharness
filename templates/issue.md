# The issue template

A tracker issue is the spec a worker session implements. Every issue the harness dispatches has these parts, in this
order; an issue missing one is not agent-ready. Acceptance criteria are written in EARS style (WHEN event THE SYSTEM
SHALL response) so each one is testable. There is no dollar or token budget anywhere: workers run on subscription
logins (Rob, Nov 2, 2026), and the caps are cycles, turns and wall time.

```markdown
Title: <verb> <thing> (one deliverable)
Labels: agent-ready, risk:low|med|high, size:S|M
Project: <Linear project; the unit of the single human review>

## Goal
One or two sentences: the user-visible outcome.

## Acceptance criteria (each one testable; EARS style welcome)
- [ ] WHEN <event> THE SYSTEM SHALL <response>
- [ ] ...

## Verification
- Tests to add or update: <paths>
- Manual check the agent must perform and capture: <steps, screenshot>

## Touches (file lease)
- src/... (edit)
- tests/... (edit)

## Out of scope
- ...

## Context
- Links, related issues, prior PRs

## Caps (no dollar or token budget; subscription logins only)
- Max cycles: 8   Max turns: 80   Max wall time: 90 min

## Blocked by
- <ISSUE-ID> (orchestrator will not dispatch until these are merged)
```

## How each part is used

| Part | Who reads it | What it decides |
| --- | --- | --- |
| Title, Labels, Project | the daemon | `agent-ready` makes it a dispatch candidate; `risk:*` is the flag the risk flagger checks against `risk.md`; the project is the unit of the one human review (`dod/project.md`). |
| Goal | the worker, the evaluator | the user-visible outcome the evaluator judges against. |
| Acceptance criteria | the worker (tests first), the evaluator (PASS or NEEDS_WORK) | each line becomes a failing test before any code. |
| Verification | the worker | the tests to write and the manual check to perform and capture (screenshot, trace). |
| Touches | the daemon (the lease), the reviewer (the diff stays inside it) | one file, one owner at a time; overlapping issues are never co-scheduled. When an issue lists no Touches, the project's `WORKFLOW.md` says what the default lease is (`touches.default`). |
| Out of scope | the worker, the evaluator | what a PASS does not require and the diff must not include. |
| Context | the worker | links, related issues, prior PRs. |
| Caps | the daemon, the worker | the stop conditions: 8 cycles, 80 turns, 90 minutes by default; a project's `WORKFLOW.md` may set its own defaults. |
| Blocked by | the daemon | nothing is dispatched until every blocker is merged. |
