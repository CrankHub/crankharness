# CrankHarness

One agent delivery harness for every CrankHub project: a daemon that takes agent-ready issues from the tracker,
gives each its own worktree and branch, runs a headless worker on a subscription login, gates on the project's local
gate and a fresh-context evaluator, and lands PRs through the merge queue. Agnostic by design (Rob, Nov 2, 2026);
[CrankHub/crankmagic](https://github.com/CrankHub/crankmagic) is the first project it drives.

This repository holds everything that is **not** project-specific. What a project provides is the contract.

| File | What it is |
| --- | --- |
| [`CONTRACT.md`](CONTRACT.md) | what a project repository must provide (`AGENTS.md` with six sections, `CLAUDE.md` pointing at it, `WORKFLOW.md`, a verify skill with a feature map, a local gate), and the refusal when one is missing |
| [`check-contract.mjs`](check-contract.mjs) | the check: `node check-contract.mjs <path>` prints PASS or names each missing part |
| [`templates/issue.md`](templates/issue.md) | the issue template: goal, EARS acceptance criteria, verification, Touches, out of scope, context, caps (no dollar budget), blocked by |
| [`templates/AGENTS.sections.md`](templates/AGENTS.sections.md) | the six generic sections a project merges into its own `AGENTS.md` by hand |
| [`templates/WORKFLOW.md`](templates/WORKFLOW.md) | the runtime policy file the daemon reads, to copy and fill in |
| [`dod/issue.md`](dod/issue.md) | the issue-level definition of done (14 lines; the merge agent marks Done) |
| [`dod/project.md`](dod/project.md) | the project-level definition of done: the one human review, per Linear project |
| [`risk.md`](risk.md) | the default risk list (what is high), what a flag does and never does, and how an agent proposes a change in `PROGRESS.md` |

The design is Rob's harness plan of Nov 2, 2026 and its decisions; the build is Linear project **P-ROB-17
"CrankHarness: the delivery harness"**, Phase 0 to 4. This repository is ROB-400. The dispatch script (ROB-404), the
hooks (ROB-405), the evaluator (ROB-406), the daemon (ROB-408) and the merge agent (ROB-412) land here as they are
built.

## Running the check

```bash
node check-contract.mjs C:/path/to/crankmagic
```

```text
check-contract: C:/path/to/crankmagic
  ok       AGENTS.md: 6/6 sections (Mission, Scope rules, Phase permissions, Stop conditions, For Rob to confirm, Done)
  ok       CLAUDE.md points at AGENTS.md
  ok       WORKFLOW.md: states Todo/In Progress/Blocked/Done, concurrency 3, branch agent/<ISSUE-ID>-<slug>, touches default lane, caps 8/3/80/90
  ok       local gate: tools/local-ci.sh <ref> 0 (tools/local-ci.sh exists)
  pending  verify skill: .claude/skills/verify/SKILL.md and .claude/skills/verify/feature-map.md do not exist yet; building under ROB-401
PASS (1 pending)
```

Exit code 0 is PASS, 1 is FAIL, 2 a usage error. `--strict` makes a pending verify skill a missing part. Against an
empty folder it names every part. `npm test` runs the check's own tests (Node 22, no dependencies).

## Rules that hold everywhere

- **No API keys, anywhere.** Workers run on the Claude Code, Codex and Grok Bot subscription logins; nothing here
  creates, reads or stores an API key, and there is no dollar cap because there is no dollar spend.
- **No secrets in this repository**, in a chat, in a tracker comment or in a commit. Secrets live in the host's
  credential store or the daemon's environment; a file here names a secret's *name*, never its value.
- **Merges and Done are automatic** once every automated gate is green; the one human checkpoint is the review per
  project (`dod/project.md`). High-risk work is flagged, never blocked (`risk.md`).
- **`AGENTS.md` is written by hand.** The harness never generates or replaces a project's rules file.
