# The evaluator (ROB-406)

A second, independent check on a finished branch. A fresh session that did not write the change, and cannot change
anything, reads the issue, the diff and the test results and answers **PASS** or **NEEDS_WORK**, criterion by
criterion. It is line 7 of the issue-level definition of done (`dod/issue.md`).

## Running it

```bash
node evaluator/evaluate.mjs --repo <path> --issue <KEY> --branch <name> [--provider claude|codex|grok] [--issue-file <path>] [--base <ref>]
```

- `--issue-file`: the issue's text (Markdown, in the shape of `templates/issue.md`). Without it the evaluator reads
  `<repo>/.harness/runs/<KEY>/issue.md`, which the dispatch script writes.
- `--provider`: which headless worker judges (default `claude`). Pick a different one from the worker that wrote the
  change where one is available: Codex for a Claude-authored change, Claude for a Codex-authored one. The dispatch
  script makes that choice; the evaluator runs what it is given.
- `--base`: what the branch is compared with. Default: `origin/main`, else `main`.

Exit 0 is PASS, 1 is NEEDS_WORK, 2 is an error (no verdict, and no `evaluation.json` is written; one from an earlier
cycle is left as it was, so read the exit code, not the file, to know whether this run gave a verdict).

## What it reads

| Input | Where from | When it is missing |
| --- | --- | --- |
| the issue: goal, acceptance criteria, Touches, out of scope | `--issue-file` or the run folder's `issue.md` | error (exit 2); an issue with no acceptance criteria is an error too |
| the diff | `git diff <base>...<branch>`, read from git, never from the working tree | an empty diff is NEEDS_WORK, with no model call |
| the test results | any `test-results*` file in `.harness/runs/<KEY>/` | NEEDS_WORK: default FAIL |
| screenshots and traces | images, videos, `.zip`, `.har`, `.trace`, `.log` in the run folder | judged without them |
| project knowledge | the branch's `WORKFLOW.md` and the verify skill and feature map it names | judged without it, and the prompt says so |

The prompt is generic and lives here (`prompt.md`). Nothing about a project is written into it: project knowledge
comes only from that project's `WORKFLOW.md` and verify skill.

## What it checks

One finding per acceptance criterion (`AC1`, `AC2`, ...), plus:

- `test-results`: the tests ran and passed. A skipped test does not count as passing.
- `verification-gap`: the tests prove the behavior, not just that the code runs.
- `touches`: every changed file is inside the issue's Touches list. The script checks this itself, as it checks for a
  missing test-results file; the model cannot overrule either.

The verdict is PASS only when the model says PASS **and** every finding is met. Anything else is NEEDS_WORK.

## What it writes

`<repo>/.harness/runs/<KEY>/evaluation.json`:

```json
{
  "issue": "EX-1",
  "branch": "agent/EX-1-greet",
  "base": "main",
  "provider": "claude",
  "verdict": "NEEDS_WORK",
  "criteria": [
    { "id": "AC1", "text": "WHEN ... THE SYSTEM SHALL ...", "met": false, "evidence": "..." }
  ],
  "remediation": ["one thing to do per gap; the dispatch script feeds these back to the worker"],
  "notes": "a few plain sentences"
}
```

Beside it: `evaluation.prompt.md` (what the model was asked), `evaluation.reply.txt` (what it answered) and
`evaluation.prev.json` (the previous cycle's verdict).

## Why it cannot change anything

- It reads the branch through git (`git diff`, `git show`). It never checks anything out.
- The model runs in a temporary folder outside the repository that holds copies of the evidence, deleted afterwards.
- `claude -p` runs with only the Read, Glob and Grep tools, in `dontAsk` mode, with no MCP servers and no saved
  session. `codex exec` runs in its read-only sandbox. Grok Bot is not wired yet (its login is ROB-403); the place to
  add it is the `grok` entry in `PROVIDERS` in `evaluate.mjs`.
- Every worker uses the machine's subscription login. Nothing here reads, needs or stores an API key.

## Testing it

`npm test` runs `tests/evaluator.test.mjs` with a fake worker: `CRANKHARNESS_EVALUATOR_CMD` names a command that gets
the prompt on stdin and prints a reply, so the tests never call a real model. The same variable lets anyone swap in
another worker by hand.
