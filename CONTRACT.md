# The project contract: what a repository must provide

One harness drives every CrankHub project (Rob, Nov 2, 2026: agnostic, CrankMagic first). Everything that is not
project-specific lives here; a project repository provides the four parts below, and the harness refuses a repository
missing any of them and names the part. `check-contract` is the check; the daemon (ROB-408) runs it before any
dispatch, and ROB-420 drives a second project through the same contract.

## The four parts

### 1. `AGENTS.md`, carrying the harness's six sections

The project's rules of engagement, written by a maintainer, at the repository root. It carries the six generic
sections of `templates/AGENTS.sections.md`, each under a heading whose text starts with the section's name
(any heading level, so they may sit under an umbrella heading of the project's own):

| Section | Heading starts with |
| --- | --- |
| the mission (one issue per session; the issue body is the spec) | `Mission` |
| the scope rules (Touches, one file one owner, what not to edit) | `Scope rules` |
| the phase permissions (read-only to plan, write in the worktree, never deploy) | `Phase permissions` |
| the stop conditions (cycles, same failure, turns, wall time, usage limit) | `Stop conditions` |
| the for-rob rule (`for-rob/<ISSUE-ID>.md`; Rob is never a dependency) | `For Rob to confirm` |
| the Done rule (the issue-level definition of done; the merge agent marks Done) | `Done` |

They are **merged by hand** into the file that exists, never generated and never replacing it: the harness plan cites
the finding (reported by Addy Osmani from an ETH Zurich study) that LLM-generated AGENTS.md files did not help while
developer-written ones did. Where the project's own rules say more, they stay and the sections point at them.

### 2. `CLAUDE.md` pointing at `AGENTS.md`

Claude Code reads `CLAUDE.md`; the contract keeps one canonical `AGENTS.md` and `CLAUDE.md` names it (a one-line
pointer, or a few lines that begin by sending the reader there). Other harnesses read `AGENTS.md` directly.

### 3. `WORKFLOW.md`: the runtime policy the daemon reads

A Markdown file at the root with YAML front matter (the shape OpenAI's Symphony uses) followed by prose for the
worker. The front matter is what the daemon parses; `templates/WORKFLOW.md` is the starting copy. Required keys:

| Key | Meaning | Check |
| --- | --- | --- |
| `harness` | `crankharness` | equals |
| `contract` | the contract version this file follows | `1` |
| `tracker.kind` | `linear` (later `ado`) | present |
| `tracker.states.todo`, `.in_progress`, `.blocked`, `.done` | the tracker's state names for the four the daemon moves between | all four present and non-empty |
| `concurrency` | sessions at once in this project; 3 by default, raised only while the PASS rate and the revert rate hold | integer, at least 1 |
| `branch.pattern` | the branch a dispatched worker gets | contains `<ISSUE-ID>` |
| `gate.local` | the local gate command a worker runs before every push, as it is typed | its first word is a file in the repository, or a bare command |
| `touches.default` | what the lease is when an issue lists no Touches (`lane`, `none`, or a path list) | present |
| `verify.skill` | the verify skill's `SKILL.md` (part 4) | file exists, or `verify.pending` names an issue |
| `verify.feature_map` | the feature map the skill ships (part 4) | file exists, or `verify.pending` names an issue |
| `verify.pending` | the issue key building the verify skill, while it is missing | optional; an issue key like `ROB-401` |
| `caps.cycles`, `.same_failure`, `.turns`, `.wall_minutes` | the default stop conditions (8, 3, 80, 90) | integers |

The daemon reads nothing else from the project to decide how to run it: lanes, suites and release rules are the
project's own, named in its `AGENTS.md`, and the worker reads those.

### 4. A verify skill with a feature map

A skill in the open Agent Skills layout (`SKILL.md` with `name` and `description` in its front matter) that lets an
agent run the application the way a user would, plus a feature map: how to reach every feature (routes, selectors,
shortcuts, fixtures), so a vague report can be reproduced and a finished issue can be checked in the running app.
It is the single highest-leverage investment the plan names (Lauren Tan). `WORKFLOW.md` points at both files.

While a project's verify skill is still being built, `WORKFLOW.md` says `verify.pending: <ISSUE-KEY>`; the check
reports the skill as pending and still passes, and the daemon dispatches only issues whose verification is a test
suite, never one that needs the running app. `check-contract --strict` treats pending as missing, which is how the
daemon runs it once the project's verify skill exists.

### The local gate

Part of `WORKFLOW.md` (`gate.local`), named here because it is what the Stop hook and the dispatch script run: one
command, deterministic, that a worker runs in its worktree before every push and that PR CI runs again. For
CrankMagic it is `tools/local-ci.sh <ref> 0` (the secret and personal-address scan and the clean merge with main)
plus the suites a change touches, named in its `AGENTS.md`.

## The refusal

`check-contract <path>` prints one line per part, `ok`, `pending` or `MISSING`, then `PASS`, `PASS (n pending)` or
`FAIL: n missing`, and exits 0 on PASS and 1 on FAIL. A `MISSING` line names the part and the file or key the
repository lacks. The daemon refuses to dispatch to a FAIL and posts the lines on the issue it would have dispatched.
Against an empty folder it names every part.

## What is not in the contract

The hooks (ROB-405), the evaluator (ROB-406), the run folders (ROB-410) and the merge agent (ROB-412) are the
harness's and come with it; a project does not provide them. `for-rob/` and `FOR_ROB_TO_CONFIRM.md` (ROB-402) are
created by the first finished issue, so their absence is not a contract failure. Rulesets and the GitHub App are
owner-side setup (ROB-398, ROB-399), checked by the daemon at run time, not here.
