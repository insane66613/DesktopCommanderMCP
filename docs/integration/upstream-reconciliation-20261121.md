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

## Second backport batch: file lifecycle and search bounds (2026-11-21)

The current fetched upstream still ends at `9a101b17` (v0.3.4).
The fork's original baseline for this batch is `55526f65`.

- Upstream `d29e3090`, `src/utils/files/text.ts`: ensure the underlying
  `fs.ReadStream` is destroyed and fully closed before a partial
  `read_file` or `read_multiple_files` response returns. Preserve the
  fork's optimized native-file-descriptor reverse-tail reader.
- Local reconciliation: the fork's estimated byte seek for large positive
  line offsets returned incorrect lines when record lengths varied.
  Replace it with exact, bounded-memory streaming; remove the unused
  approximate-seek helper and thresholds. Tradeoff: large deep-offset reads
  now require a linear scan rather than an approximate seek. Do not claim
  a speedup on that path without benchmarking.
- Upstream `d4a3c7d3`, `src/tools/schemas.ts`: constrain search limits,
  context lines, timeouts, and pagination to whole numbers. Add Zod 3
  safe-number validation. Preserve negative *integer* offsets for
  documented tail behavior, with page length at least one.
- Keep the fork's current `test/test-remote-channel-reconnect.js` version:
  the upstream commit touched that unrelated fixture and conflicted.
- Source audit: remote authentication's endpoint allowlist, session binding,
  and redirect rejection were already present. Do not duplicate
  `fec69812` or introduce the new Supabase3 endpoint without verifying
  its ownership and deployment requirement.
- No GitHub Actions or automated GitHub code review were requested.

## Performance follow-up: accurate deep-offset reads, no persistent cache

The preceding file lifecycle backport restored correctness at a cost: reading
line 5000 from a synthetic 15.2 MB variable-length text file scanned thousands
of strings using the readline iterator (~10-11 ms median on Node v24.15.0,
Windows). An approximate byte seek was faster but returned the wrong records.

This follow-up scans 64 KiB buffers using Node's `FileHandle.read` and V8's
native regexp engine over a Latin-1 byte-preserving view, counting every
`\r\n`, `\r`, or `\n` delimiter, including a CRLF pair split at a
buffer edge. It seeks only to an *exact* byte position, then uses the existing
readline/stream close helper for the requested result. The file handle is
closed in `finally`; no persistent offset index, retained content, watcher,
or stale file cache is introduced. UTF-16, shallow offsets, negative offsets,
and non-integer legacy offsets retain their earlier paths.

Five-run same-process synthetic benchmark, 15,238,844 bytes, offset 5000:
baseline exact readline 10.14 ms median; initial native-regexp candidate
5.26 ms median, both correct. This is a synthetic case, not production
throughput or a guarantee for every filesystem. A slower initial
`Buffer.indexOf` variant (~20 ms) and JS byte loop (~15 ms) were rejected.

Regression `test/test-deep-offset-byte-scan.js` covers mixed CRLF/LF/CR
newlines, multibyte UTF-8, delimiter at 64 KiB boundary, no delimiters,
aborted reads, immediate Windows rename after read, file replacement,
and legacy fractional offsets. Consulted Context7 for Node 24
`FileHandle.read`, stream start offsets, and descriptor closure.
