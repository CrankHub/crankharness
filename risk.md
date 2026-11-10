# Risk: the default list, and how an agent proposes a change

Rob, Nov 2, 2026: agents classify risk with a default heuristic list; a high-risk item is flagged, never blocked;
it merges through the same gates as everything else and is reviewed once, with its project. Agents propose changes to
the list in `PROGRESS.md`.

## The default list: these are high

An issue, a PR or a diff that touches any of these carries `risk:high`, in Linear, in its `for-rob/<ISSUE-ID>.md`
entry and in the project evidence bundle. The categories are Rob's; the patterns beside them are the harness's
starting heuristics (judgment) and are what the risk flagger (ROB-413) checks.

| Category | What it means | Starting patterns (judgment) |
| --- | --- | --- |
| Auth and security | sign-in, sessions, tokens, permissions, allow-lists, anything that decides who may do what | `auth`, `access`, `session`, `permission`, `allowlist`, `invite`, `password`, `crypto` in a path or a symbol |
| Secrets and config | how a secret is read, named, stored or passed; environment files; deployment configuration | `.env*`, `wrangler.*`, `secrets`, `*.pem`, `credential`, a CI variable, a Credential Manager entry |
| Migrations and schema | a change to a database schema, a migration file, a stored data format or a versioned contract | `migrations/**`, `schema/**`, a `@1`-style versioned contract, a manifest's format |
| Destructive | anything that deletes, truncates, overwrites or moves data or history it did not create | `rm -rf`, `DROP`, `DELETE`, `TRUNCATE`, `git push --force`, `git clean`, `worktree remove` |
| Payments | money, prices shown as a transaction, purchase flows, billing, seats | `payment`, `checkout`, `billing`, `stripe`, `order` as a purchase |
| Infra and CI | workflows, runners, deploy scripts, release tooling, rulesets, hooks | `.github/**`, `tools/release-*`, `tools/local-ci.sh`, `.claude/settings*.json`, hooks |
| Broad refactors | a change whose Touches span more than one lane or ownership unit, or rename or move many files | more than one lane in Touches; more than 20 files; a rename across directories |

Everything else defaults to `risk:low`; `risk:med` is for a change that is reversible but visible to every user (a
shared layout, a shared contract's field, a data refresh).

## What a flag does, and never does

- **It is a flag.** `risk:high` goes on the issue, in the for-rob entry and in the project bundle's "Flagged items",
  so the one review per project looks there first.
- **It never blocks.** No gate reads the flag to hold a merge or a Done; there are no per-issue holds (Rob, Nov 2,
  2026). A high-risk change still has to pass every automated gate like any other.
- **It is scored by agents.** The worker sets it when it opens the PR; the risk flagger (ROB-413) re-scores the diff
  and corrects it; the reviewer may raise it, never lower it.

## Proposing a change to the list: `PROGRESS.md`

An agent that finds the list wrong for its project (a category missing, a pattern that flags everything, a pattern
that misses the real risk) does not edit this file in its PR. It writes a proposal in the worktree's `PROGRESS.md`,
the progress file every session keeps, under a heading `## Risk list proposal`:

```markdown
## Risk list proposal

- Category: <existing category, or "new: <name>">
- Change: <add | remove | narrow | widen> <the pattern or category>
- Why: <the diff or the finding that showed it, with the PR link>
- Evidence: <what was flagged and should not have been, or was not and should have been>
```

The dispatch's run folder keeps `PROGRESS.md`, so the proposal reaches the project evidence bundle ("Flagged
items"). Rob accepts or declines it at the project review; an accepted proposal is a PR to this file, made by hand
or by an issue in this repository's own project. A proposal never changes the flag on the PR that made it.
