# DesktopCommanderMCP upstream reconciliation, 2026-11-21

## Verified source baseline

- Fork main before this batch: `61f8b111` (v0.2.52 package metadata).
- Latest fetched upstream main: `9a101b17` (v0.3.4, 2026-11-18).
- Graph divergence at audit: 819 upstream-only and 166 fork-only commits.
- Tree comparison: 563 changed files; an automatic merge has 104 conflict reports.
- The fork contains custom process, output, diagnostics, remote and config changes. Do not resolve the 104 conflicts wholesale using an automatic ours/theirs policy.

## Applied and locally verified

- `14816db0`: adapt upstream `5148b5fd`. Node 22 on Windows needs the libuv pool size in the process environment at startup, not only `process.env` after launch. Existing pool-size tests passed; existing user override remains honored.
- `8fba161f`: adapt upstream `11d3f583` to the fork's structure. Restore missing Windows ProgramData from verified system-drive context and repair PATHEXT for both shell processes and node:local without modifying the parent environment. New regression tests passed.
- `9aaa8063`: align `unpdf` to upstream-compatible `~1.8.1`. The fork already has the PDF document closure fix, so it was not duplicated. PDF lifecycle, parsing, single-fetch and edit-block tests passed.

## Safety and integration policy

- Preserve the fork's custom process admission, response budgeting, file-adapter contracts, remote privacy, and auth hardening.
- Do not request, rerun or depend upon GitHub Actions or automated code review. Use local build and isolated tests. Commits contain `[skip ci]`.
- Do not report a runtime upgrade until the managed service is rebuilt/restarted and independently probed. Updating Git branches alone is not deployment.

## Deferred upstream candidates requiring separate validation

| Upstream change | Decision and gate |
|---|---|
| `135a90bc`, terminate the whole process tree from `kill_process` | Fork's `terminalManager.forceTerminate` and process lifecycle contracts differ; requires a separate session-tree test and safe handling of PID reuse before adoption. |
| `fec69812`, validate remote auth backend before restoring persisted session | Security-sensitive; reconcile with already-backported trust/redirect protections, and test persisted-token binding. Do not merge piecemeal. |
| `6cb7f9d4`, add third Supabase auth origin | Expands an allowlist to `example.supabase.co`; independently confirm production endpoint ownership and need before trusting it. |
| `19aad35a`, feature-flagged MQTT transport | Requires older transport changes and rollout gates. Do not enable MQTT by default until end-to-end validation of enrollment, logout, and privacy controls. |
| Upstream release/GitHub Actions changes | Excluded by standing no-GitHub-Actions validation policy. Do not copy metered CI workflows into the fork. |

## Validation record

- Context7 checked against Node.js 22 behavior and `unpdf` API/lifecycle before code modification.
- `npm run build`: passed after each backport cohort.
- Threadpool, command environment, and affected PDF regression tests: passed.
- The full upstream v0.3.4 tree is **not** integrated; package metadata stays v0.2.52 intentionally.
- Cross-module validation: 25 test modules passed, 0 failed, 3 individual platform-only checks skipped (/bin/sh, /bin/bash, macOS/Linux process groups on Windows). Log: `X:\\MCP\\scratch\\deskcommand-reconcile-validation-20261121.log`.
- Re-run the separate process-tree and MQTT suites before any future adoption of their upstream implementations.
