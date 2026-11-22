# Archived October 14, 2026 upstream-v0.3.0 evaluation

This document records the historical state at that date, not current build or release status. Its upstream and fork SHAs are superseded by later selective reconciliations. The original failed experimental merge was independently archived on November 22, 2026 and must not be merged wholesale.

---

# Desktop Commander upstream v0.3.0 integration, 2026-10-14

Status: NOT READY TO MERGE OR DEPLOY. This is a disposable isolated integration worktree, not the production checkout.

- Production checkout: `X:\Code\DesktopCommanderMCP`, `main`, commit `4f0ed60`; working tree remained clean.
- Upstream: `wonderwhy-er/DesktopCommanderMCP` `origin/main` at `67694ca` (v0.3.0).
- Divergence before merge: 131 fork-only commits, 280 upstream-only commits.
- Primary worktree: `X:\Worktrees\DesktopCommanderMCP\upstream-v0.3.0-integration-20261014`, branch `integration/upstream-v0.3.0-20261014`; merge `-X ours` remains uncommitted; conflict count 0 after strategy, but 141 TypeScript diagnostics after pinning two core files to fork.
- Upstream-favored evaluation: `X:\Worktrees\DesktopCommanderMCP\upstream-v0.3.0-theirs-eval-20261014`, branch `integration/upstream-v0.3.0-theirs-eval-20261014`; merge `-X theirs` remains uncommitted; two syntax issues surgically corrected, then 132 TypeScript diagnostics.
- Initial plain merge revealed 73 conflict paths; automatic resolution does not prove semantic correctness.
- Dependency installation was successful in isolated primary worktree after reconciling merged lockfile with `npm install --package-lock-only`; `npm ci` installed 730 packages. Evaluation worktree uses a junction to primary `node_modules`.
- Neither candidate passes TypeScript compilation. No merge was promoted to fork `main`, no remote integration branch was pushed, and no production restart was performed.
- Current fork security tests passed: `test-read-url-ssrf.js`, `test-config-corrupt-concurrency.js`, `test-config-recovery.js`, `test-remote-channel-reconnect.js`, `test-process-start-completion.js`, `test-ui-event-tracking.js`, `test-process-pagination.js`, `test-atomic-write.js`, and `test-default-shell.js`.
- Older branch security functionality is largely present in fork `main`; do not blindly cherry-pick its stale commits.

Release blockers: resolve TypeScript errors while preserving customized tools, process responses, command security, sensitive file policy, cancellation, rate limits, auth, remote behavior; reconcile package lock; run full Windows tests and portal semantic MCP tests. Until then do not publish or restart.
