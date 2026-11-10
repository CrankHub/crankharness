# Issue-level definition of done

Verbatim from the harness plan (Nov 2, 2026), with Rob's decisions of that day: the merge agent marks an issue Done
when every line below is true; no human approves an individual merge or issue; high-risk work is flagged, never
blocked; the one human review is per Linear project (`project.md`).

```text
Issue-level definition of done (the agent may mark Done when every line is true)

Tests and verification
1. Tests were written first from the acceptance criteria, seen failing, then passing.
2. Every file touched has tests covering the changed lines and branches.
3. The CI coverage diff on the PR shows no drop in line or branch coverage for touched files.
4. UI changes have a passing Playwright e2e test, with a screenshot or trace in the run folder.
5. Verification-gap check: the reviewer confirms the tests prove the behavior,
   not just that the code executes.

Gates
6. The stop-hook loop and `tools/local-ci.sh` pass in the worktree; the same checks pass in PR CI.
7. A fresh-context evaluator with no write tools returned PASS against the issue.
8. The cross-model review agent has no unresolved findings.
9. Risk is scored and flagged (risk:high plus the for-rob entry); it never blocks the merge.
10. The diff stays inside the Touches list, or the extra files were approved.
11. No secrets: the secret scan is clean and there are no new .env or credential files.
12. Merged through the queue without force-push; merge-queue CI on main is green.
13. The run folder (diff, tests, coverage, verdicts, tokens) is linked from the PR and the issue.
14. For-Rob entry appended: for-rob/<ISSUE-ID>.md exists, with test steps and risk flags.
Then the merge agent merges and the issue moves to Done automatically (Trey, Nov 2, 2026).
It is reviewed once, with the rest of its Linear project, at project completion.
```

Line 6 names `tools/local-ci.sh` because the plan was written against CrankMagic; for any project it means the local
gate command its `WORKFLOW.md` declares (`gate.local`, `CONTRACT.md`).

## Which lines each phase can prove

The lines are the definition from day one; what can prove them arrives by phase (Linear project P-ROB-17).
Until a gate exists, the line is reported as "not yet provable: <issue>" in the PR, never as passed.

| Lines | Proved by | Arrives with |
| --- | --- | --- |
| 1, 2, 4, 5, 10, 11, 14 | the worker and the reviewer, by hand, from the diff and the run folder | Phase 0 (ROB-400, ROB-401, ROB-402) |
| 6 | the Stop hook and the local gate | Phase 1 (ROB-404, ROB-405) |
| 7 | the fresh-context evaluator | Phase 1 (ROB-406) |
| 13 | the run folder | Phase 2 (ROB-410) |
| 8, 9 | the cross-model reviewer and the risk flagger | Phase 3 (ROB-413) |
| 3 | the coverage diff on the PR | Phase 3 (ROB-414) |
| 12 | the merge agent and the merge queue | Phase 3 (ROB-398, ROB-412) |
