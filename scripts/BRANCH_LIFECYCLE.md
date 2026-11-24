# DeskCommand branch/worktree reconciliation

This CLI is deliberately **read-only by default** and does not change the running
DeskCommand service. It inventories remote branch tips, local worktrees, tracking
mismatches, stale worktree metadata, and unique unmerged patches. It does not
equate a branch's age or number of commits with obsolete functionality.

## One bounded audit (PowerShell 7)

Run from the DeskCommand repository, or a clean isolated worktree:

~~~powershell
npm run branches:audit -- --remote fork
npm run branches:audit -- --remote fork --json --output 'X:\CodeArchives\deskcommand-branch-audit-20261123.json'
npm run branches:audit:test
~~~

The report records exact remote heads plus classifications:

| Classification | Meaning | Next action |
| --- | --- | --- |
| PROTECTED | Main, upstream PR lane, release lane or checked-out worktree | Preserve |
| UNFETCHED_OR_MOVED | Local object or tracking tip does not match live remote | Fetch/inspect, never delete |
| MERGED_IN_MAIN | Remote SHA is a real ancestor of current main | Candidate for verified retirement |
| PATCH_EQUIVALENT_CANDIDATE | No right-only nonmerge patches and no unique merge commits | Manual equivalence review |
| UNIQUE_REVIEW | Unique unmerged patch or merge history | Inspect files and tests, keep by default |

Git patch equivalence is *not* semantic correctness proof. A candidate still
requires ownership, use/consumer and current pull-request review. The CLI reports
stale metadata with git worktree prune --dry-run and
git remote prune --dry-run; **it never prunes worktrees automatically**.

## One exact retirement

Do not batch deletion. For an integrated branch with no open PR and no checkout:

~~~powershell
npm run branches:audit -- --remote fork --apply --retire 'specific/branch' --expect-sha 'FULL_40_CHARACTER_SHA' --archive-dir 'X:\CodeArchives\deskcommand-retired'
~~~

The command checks the current remote SHA, clean worktree, protected names,
current GitHub fork/upstream open PRs, and ancestry. Before deleting, it creates
a complete, verified Git bundle containing both main and the retiring ref,
writes a prepared JSON receipt, and verifies the bundle SHA-256. Deletion uses
an exact-SHA --force-with-lease and readback. It does not force-remove local
branches or worktrees. An existing archive path stops the operation.

To retire a patch-equivalent (but not ancestor) branch, add
--allow-patch-equivalent **only after reviewing its full file-level differences**
and absence of unique merge resolutions.

**Unique branches cannot be deleted by this CLI.** Preserve their full history
and independently verify obsolete/superseded behavior, active PRs, and current
consumers before a separate manually reviewed retirement. No forced cleanup of
dirty, untracked or active worktree content.

The CLI fails closed if gh cannot verify open pull requests, the local branch
tracking differs from the GitHub remote, a bundle fails verification, the SHA
changes, or the current checkout is dirty.

## Recovery and next-chat handoff

Preserved bundle heads can be inspected with git bundle list-heads FILE and
restored to a new branch with
git fetch FILE refs/remotes/fork/BRANCH:refs/heads/recovered/BRANCH.
The JSON receipt includes the exact tip, bundle SHA-256, source commit and a
restore command. Record only the delta in the canonical Notion branch crosswalk;
keep large JSON inventories and hashes in dated archives. Before any source or
production claims, check Git and the installed supervised release separately.
