# Providers: Claude, GPT and Grok through one interface

Rob, Nov 14, 2026: the three work in unison and divide the work between them. The harness treats a provider as a
replaceable worker. Everything above the adapter is the same for all three.

Names: a provider is `claude`, `gpt` or `grok`, in labels (`provider:gpt`) and in `WORKFLOW.md` alike. The tool is
Claude Code, Codex or Grok's coding agent.

## The adapter (ROB-516)

One file per provider, each implementing:

| Call | Does |
| --- | --- |
| `available()` | whether the tool is installed and signed in on a subscription login, and which capabilities it has |
| `start(job)` | starts a headless worker in a worktree on a branch, on a named model, with the issue text and the project's rules file; returns a handle |
| `status(job)` | running, finished, stopped at a limit, signed out, or failed, with the reason |
| `stop(job)` | stops it and leaves the branch pushed |
| `usage()` | how close the subscription is to its limit, as far as the tool reports it |

A job's outputs are the same from every provider: a pushed branch, a draft pull request, a hand-back file, a
checkpoint, a run folder.

The adapter interface is written first, as its own small pull request, and the dispatch script (ROB-404) is built
against it, so dispatch is never built for one provider and reworked.

## Fences that do not depend on the tool

Hooks are a Claude Code mechanism. A rule that only a hook enforces is not enforced on the other two. So every
fence has a tool-independent form in the adapter or the orchestrator:

| Fence | Enforced by |
| --- | --- |
| Touches | the diff against the lease, checked at hand-back and again at merge; a diff outside it is refused |
| Wall time and turns | the adapter's clock and `stop(job)` |
| Secrets and forbidden files | the project's gate, run by the harness on the branch, not by the worker |
| No push to main, no deploy | the ruleset: only the harness's GitHub App lands on main |
| Shared files | the diff check, against `shared_files` |

Where a tool has hooks or a sandbox, they are used as well, as an earlier warning.

## The checkpoint

A worker commits as it goes and keeps `.harness/progress/<ISSUE-ID>.md` on its branch up to date with every
commit: what is done, what is next, what it tried. A worker stopped without warning has therefore already left its
checkpoint. The next worker, on any provider, resumes from the branch. The worker that finishes the issue
deletes the checkpoint in its last commit before handing back.

## Capabilities, and what is not yet known

| Capability | Needed for | Claude Code | Codex | Grok |
| --- | --- | --- | --- | --- |
| Runs headless from a command | stage 1 and up | yes | to be verified | **unknown** |
| Takes a model name | tiers | yes | to be verified | **unknown** |
| Reads the project's `AGENTS.md` unprompted | every job | through `CLAUDE.md` | yes | **unknown** |
| Reaches the tracker, read and write | stage 0 hand-back | through a connector | to be verified | **unknown** |
| Reaches GitHub: push, pull requests | every job | yes | to be verified | **unknown** |
| Starts a fresh session per job | evaluation | yes | to be verified | **unknown** |
| Runs the project's gate | workers at stage 0 | yes | to be verified | **unknown** |
| Reports its usage | routing | partly | to be verified | **unknown** |
| Signs in without a person | staying up | no: a lapsed login needs a person | to be verified | **unknown** |

From stage 1 the harness, not the tool, talks to the tracker and runs the gate, so a provider needs only the
first five rows. The first task of ROB-516 is to fill this table from what each tool actually does. A provider
that cannot run headless works at stage 0 only, and the harness says so plainly. **A lapsed subscription login is a
known human touchpoint for every provider:** the orchestrator routes around it and reports it; it cannot fix it.

## Tiers (ROB-517)

| Tier | For | Default rule |
| --- | --- | --- |
| A, frontier | design-heavy work, contracts, validation, planning, all evaluation | `size:M`, or `risk:med` and above, or labeled `tier:A` |
| B, standard | a well-specified feature inside one lane; routine orchestrator chores | everything else |
| C, fast | mechanical work: copying, renaming, running suites, mirroring pages | labeled `tier:C` only |

A project's `WORKFLOW.md` maps each tier to a model name per provider. A name that no longer exists is an error the
orchestrator reports; it is never silently replaced.

## Who evaluates whom (ROB-518)

- The evaluator is a fresh session with no write tools. It is never the author's session.
- It is a different provider from the author whenever one is available. The project gives the order to try per
  author. A provider whose capabilities are still unknown is not put first.
- If no other provider is available, a fresh session of the same provider evaluates and the verdict is recorded as
  `same-provider`. Nothing is held back for it, in line with `risk.md`: risk is flagged, never blocked. The flag
  and the `same-provider` mark go in the for-rob entry so the one human review looks there first.
- The evaluator returns its answer to the harness. The harness writes the verdict as a commit status on the exact
  commit it judged. A worker cannot write that status, and a later commit voids it.
- After `caps.rounds` rounds of NEEDS_WORK (3 by default) the issue is Blocked.

## Routing and failover (ROB-517)

An issue's `provider:` label is a preference set by the project's plan. The orchestrator moves an issue when its
provider is unavailable, signed out, at its limit, lacks a capability the issue needs, or has failed it twice; each
provider gets a failed issue at most once more, and then it is Blocked.

## What a project writes

```yaml
providers:
  order: [claude, gpt, grok]            # who is tried first for unlabeled work
  evaluate: {claude: [gpt, grok], gpt: [claude, grok], grok: [gpt, claude]}
  claude: {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
  gpt:    {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
  grok:   {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
```

These keys are contract 2 (`CONTRACT.md`): read by people today, checked from ROB-517.
