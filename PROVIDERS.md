# Providers: Claude, Codex and Grok through one interface

Rob, Nov 14, 2026: the three work in unison and divide the work between them. The harness treats a provider as a
replaceable worker. Everything above the adapter is the same for all three.

## The adapter (ROB-516)

One file per provider, each implementing:

| Call | Does |
| --- | --- |
| `available()` | says whether the provider's tool is installed and signed in on a subscription login, and which capabilities it has (below) |
| `start(job)` | starts a headless worker in a worktree on a branch, on a named model, with the issue text and the project's rules file; returns a handle |
| `status(job)` | running, finished, stopped at a limit, or failed, with the reason |
| `stop(job)` | stops it and leaves the branch pushed |
| `usage()` | how close the subscription is to its limit, as far as the tool reports it |

A job's outputs are the same from every provider: a pushed branch, a draft pull request, a hand-back file, a run
folder.

## Capabilities, and what is not yet known

| Capability | Needed for | Claude Code | Codex | Grok |
| --- | --- | --- | --- | --- |
| Runs headless from a command | any dispatch | yes | to be verified in ROB-516 | **unknown** |
| Takes a model name | tiers | yes | to be verified | **unknown** |
| Reads the project's `AGENTS.md` unprompted | every job | through `CLAUDE.md` | yes | **unknown** |
| Reaches the tracker (read and write) | hand-back, evaluation | through a connector | to be verified | **unknown** |
| Reaches GitHub (push, pull requests, comments) | every job | yes | to be verified | **unknown** |
| Starts a fresh session per job | evaluation | yes | to be verified | **unknown** |
| Runs the project's gate (shell, the project's toolchain) | workers, evaluators | yes | to be verified | **unknown** |
| Reports its usage | routing | partly | to be verified | **unknown** |

The first task of ROB-516 is to fill this table from what each tool actually does, and to keep it true. A provider
missing a capability is used only for work that does not need it. If Grok cannot run headless, it works at stage 0
only (a person starts its sessions) and the harness says so plainly.

## Tiers (ROB-517)

Use the smallest model that does the work well, and a frontier model where a mistake is expensive.

| Tier | For | Default rule |
| --- | --- | --- |
| A, frontier | design-heavy work, contracts, orchestration, validation, all evaluation | `size:M`, or `risk:med` and above, or labeled `tier:A` |
| B, standard | a well-specified feature inside one lane | everything else |
| C, fast | mechanical work: copying, renaming, running suites, mirroring pages | labeled `tier:C` only |

A project's `WORKFLOW.md` maps each tier to a model name per provider. Model names change. A name that no longer
exists is an error the orchestrator reports; it is never silently replaced.

## Who evaluates whom (ROB-518)

- The evaluator is a fresh session of a provider other than the author's, with no write tools.
- The project's `WORKFLOW.md` gives the order to try. With three providers the usual shape is a ring.
- If no other provider is available, a fresh session of the same provider may evaluate; the verdict is marked
  `same-provider`, and `risk:high` work waits for a different one.
- The merge agent refuses a pull request without a PASS.

## Routing and failover (ROB-517)

- An issue's `provider:` label is a preference, set by the project's plan.
- The orchestrator moves an issue when its provider is unavailable, at its limit, or has failed it twice, and says
  why on the issue.
- A worker stopped at a usage limit leaves `PROGRESS.md`; the next worker, on any provider, resumes from it
  (ROB-411).

## What a project writes

```yaml
providers:
  order: [claude, codex, grok]        # who is tried first for unlabeled work
  evaluate: {claude: [grok, codex], codex: [grok, claude], grok: [codex, claude]}
  claude: {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
  codex:  {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
  grok:   {share: 1, tiers: {A: <model>, B: <model>, C: <model>}}
```

These keys become part of the contract with ROB-517; until then they are read by people.
