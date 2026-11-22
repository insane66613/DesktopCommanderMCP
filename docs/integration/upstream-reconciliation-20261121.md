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

## Managed process-tree termination backport (2026-11-21)

Functional defect: `kill_process` used Node `process.kill(pid)` and the
`force_terminate` path signaled only the managed shell PID, potentially
leaving child processes or development servers running. Adapted the
upstream `src/utils/process-tree.ts` implementation (including Windows
`taskkill.exe /PID <pid> /T /F`, and bounded POSIX tree discovery/termination),
after checking the actual Windows Node 24 signal behavior in Context7.
The helper invokes commands without a shell, limits command duration,
and waits for the managed root's exit; failures are not represented as
verified tree termination.

`terminalManager.forceTerminateAndWait` is the awaited client-facing
operation; `forceTerminate(pid)` remains a backward-compatible
initiation API for existing internal callers. `kill_process` delegates
to the awaited tree path only for a currently tracked `start_process`
session. External/unmanaged PIDs retain PID-only termination to avoid
expanding a caller's destructive scope. Runtime PID and its direct
supervisor are refused. The independent `node:local` timeout handler
was not changed. A root already exited before tree discovery cannot
guarantee discovery of a reparented descendant; neither source nor
runtime must claim otherwise.

`test/test-managed-process-tree.js` starts a disposable PowerShell 7
shell, Node intermediate parent, and Node leaf with three independently
recorded and distinct PIDs. It verifies both API routes end all three,
an unmanaged process's child is intentionally left running, and the
runtime/supervisor are protected; the test itself cleans its resources.
Focused tests also cover `test-kill-process.js`,
`test-process-pagination.js` and `test-process-inherited-stdio.js`.
Windows tests passed 4/4 modules, 0 failures, before full-suite gate.
No GitHub Actions or automated GitHub reviews are release requirements.

## Performance and functionality reconciliation: file-search result paging (2026-11-21)

Fetched the actual upstream `wonderwhy-er/DesktopCommanderMCP` main and
verified commit `9a101b17e44577f0baefa4c7120f087881c5cc56`, release v0.3.4
dated 2026-11-18. Our fork source baseline for this batch:
`34ecb0da2871df7fbbbb52e3e887d46355819d3e`. Git divergence at this
read: 819 upstream-only versus 179 fork-only commits. Do not automatically
merge divergent search, process, custom model-output or Portal adapters.

**Upstream behavior:** v0.3.4's `searchFiles` uses
`SearchManager.waitForCompletion(sessionId)`, then returns each file path
once, with a 30-second cancellation timer. That mechanism depends on a
different upstream session completion/Office-source lifecycle
(`session.completed`, `stopSources`, outcome transitions) absent from
the fork, so cherry-picking only the wrapper would not type-check or
preserve search sessions correctly. Full upstream lifecycle adoption is
deferred pending separate tests. The earlier fork compatibility path,
however, called `readSearchResults(sessionId)` with the default offset 0
and default page length 100 on every poll. This could duplicate initial
results and omit every file beyond the first 100, even though the
underlying manager had collected them.

**Bounded local backport:** preserve the fork's search-manager API and
30-second limit, but track a precise result cursor, request 1000 results
per page, drain even a completed full page, and read the first available
page immediately instead of waiting 100 ms unconditionally. With no
results yet, use a 20 ms initial sleep and bounded backoff to 100 ms.
Do not introduce a new orchestrator, persistent index/cache, or runtime
process restart. This is an adaptation of upstream's exactly-once result
contract, **not** a claim that the upstream event-driven refactor was
integrated. Context7 consulted Node.js 24 ESM, async timer/test APIs.

**Controlled wrapper benchmark (mock session, 265 file matches; five
iterations):** deployed baseline returned 117 paths, only 100 unique,
and omitted the last match; median 123.93 ms. Isolated patched build
returned all 265 once; median 0.28 ms. These times measure the wrapper
with deterministic mocked output, not real ripgrep/NTFS throughput.
Independent real fixture: 265 unique files in 224.69 ms on the
candidate in a single observed run. The fixture automatically removes
its temporary files.

**Regression:** `test/test-search-files-pagination.js` covers 265
results, initial returns, delayed zero-row reads, and a completed search
with more than 1000 results (1,234 rows), proving the final page is
drained. `test/test-search-files-real.js` covers the actual file-search
manager/ripgrep/fallback on 265 temporary files. Previous completed
search lifecycle/UTF-8/literal-search regression modules remain in
the validation gate. Changes are staged solely in the reused
`X:\MCP\scratch\deskcommand-upstream-timeout-redaction-20261121`
worktree, not in the live `X:\Code\DesktopCommanderMCP\dist`.

**Deferred upstream changes:** MQTT feature flag and release CI
changes are outside performance/functionality scope and not needed.
Upstream's event-driven search completion is a candidate for a future
bounded lifecycle integration, but not without tests for Office sources,
session cancellation, timeout, failure outcomes and final-result
preservation. Upstream's 2026-11 process-startup refactors similarly
require separate acceptance and must not bypass fork-specific process
admission or Portal runtime contracts.

## User-facing search-session pagination: performance and upstream parity

Additional call graph verification is essential: `searchFiles()` in
`src/tools/filesystem.ts` is a **legacy compatibility export**, with no
internal callers in the current MCP server. The actively used
`start_search` and `get_more_search_results` MCP tools dispatch through
`src/handlers/search-handlers.ts` directly to
`SearchManager.startSearch` and `SearchManager.readSearchResults`.
Do **not** present the compatibility-wrapper benchmark above as a
production MCP search speedup.

**Direct MCP path fix:** the fork's `readSearchResults` previously
allocated and filtered an entire session's stored result list on
*every paginated read*, then returned only the requested slice. Search
sessions with tens of thousands of matches incurred O(total results)
work even for a 20-item page. Audit of this repository found no code
that creates the old `__LAST_READ_MARKER__` sentinel; the filter was a
legacy no-op for actual produced search results. Use
`session.results` directly for indexed slicing instead of generating
a new full array. This is a local performance improvement beyond the
upstream v0.3.4 implementation, which also filters every page.

**Functionality parity from upstream:** fix negative/tail offsets so
they refresh `session.lastReadTime` just like positive-offset reads.
The fork previously refreshed only positive reads, allowing tail-only
consumers to be evicted while they were still reading. Upstream
`4976a3e1` refreshes the timestamp on all reads. Move the update
ahead of both branches, without changing user-facing paging text,
completion status, errors or the fork's session state API.

**Controlled in-process benchmark:** 50,000 synthetic stored results;
200 paginated calls requesting 20 results near the end of the session.
The deployed baseline `SearchManager` median was 0.6858 ms per call
and did **not** refresh tail-only read activity. The combined isolated
candidate median was 0.0007 ms per call; the candidate did refresh
tail-read activity. These are deterministic in-memory unit timings,
not per-request MCP transport latency or production throughput.
`test/test-search-session-pagination-performance.js` also verifies
that actual `handleGetMoreSearchResults` outputs the expected final
three paths for the same in-memory session and that the session is
removed from the test process in a `finally` block.

The legacy wrapper retains an exact cursor and bounded backoff to
preserve compatibility; active MCP tools benefit directly from the
`SearchManager` change. The new real-search fixture uses its own
`import.meta.url` directory for temporary files because the all-tests
runner executes with `cwd=test`. An initial full run of 158 modules
passed 157 but failed this fixture path setup; the error was not a
search assertion. The fixture was corrected before final validation.
The final full-suite receipt is tracked in
`X:\MCP\scratch\deskcommand-search-full-final-20261121.log`.

### Final validation receipt (same tested candidate, before merge)

- `npm run build` TypeScript/compiled dist: passed in the reused isolated
  worktree; live `X:\Code\DesktopCommanderMCP\dist` was not rebuilt.
- Full `node test/run-all-tests.js` **159/159 modules passed, zero failed**,
  with five documented environment/platform skips: unavailable Windows
  `/bin/sh` and `/bin/bash`, nonstandard Chrome Program Files layout,
  unavailable POSIX process groups, and a symlink-reporting condition.
  Log: `X:\MCP\scratch\deskcommand-search-full-final-20261121.log`.
- The first full attempt had 157/158 passes with one test-fixture setup
  failure caused by the runner's `cwd=test`. Correcting the fixture to use
  `import.meta.url` yielded the 159/159 clean final run; no production
  behavior was changed to mask that test error.
- Twelve existing/added focused search module tests passed; the new tests
  cover 265 unique filesystem matches, 1,234-result pagination, and
  in-memory direct MCP search result/tail behavior with 50,000 matches.
- Latest upstream main independently verified `9a101b17`, v0.3.4.
  No wholesale rebase, version bump, MQTT activation, GitHub Actions
  request, or automatic upstream code review is part of this change.
- **Production status at validation:** the healthy managed MCP runtime
  still uses released `34ecb0da`; source merge alone is not a deployed
  performance update. A subsequent supervised rollout must respect the
  Portal's reviewed manifest pin policy.

## Upstream functional backport batch: literal file searches and oversized timers (2026-11-21)

**Verified upstream head:** `9a101b17e44577f0baefa4c7120f087881c5cc56`
(release v0.3.4, published Nov 18). Source baseline for this batch:
`b0a541bbb2b3eff51055323f52f6629824029f08` (already
independently deployed and live-smoke verified).

**Ported behavior from upstream:**

- Upstream `b15aa64c`: for file searches,
  `literalSearch=true` now interprets metacharacters `* ? [ ] { }`
  as literal characters in names instead of accidentally using glob
  syntax. The fork passes a ripgrep `--glob` or `--iglob` pattern;
  this change escapes glob metacharacters and retains exact filename
  handling (and the existing 1,500-ms default exact-name timeout).
  Existing non-literal/glob semantics remain unchanged.
- Upstream `6874b0de`: Node's `setTimeout` treats delays greater than
  2,147,483,647 ms as 1 ms. The fork previously passed huge explicit
  `timeout_ms` values directly to Node; now they are bounded to the
  largest supported timer duration, preventing premature cancellation.
  The user's explicit finite timeout is not persisted or modified.
  Node.js 24 official timer documentation was consulted through Context7.

**Reproduced before modifying source:**
`test/test-search-files-literal-upstream.js` failed when the requested
literal `report[1].txt` returned `report1.txt` and omitted the two
files actually containing brackets. The timeout regression captured an
unbounded scheduled delay of 2,147,483,648 ms (which Node would coerce
to 1 ms). Both tests passed after the changes in the isolated compiled
candidate, including literal substring `rt[1]`, literal braces
`{a}`, normal `report[1].txt` glob behavior, brace alternation,
and large explicit timeouts 2,147,483,648 and 3,000,000,000 ms.
The first literal fixture was corrected to avoid a Windows-invalid
asterisk in a filename before evaluating source behavior.

**Bounded scope:** only `src/search-manager.ts` plus two executable
search regression modules, and this reconciliation entry. Do not
blindly cherry-pick the upstream's larger `SearchManager` session
completion and outcome rewrite or enable optional MQTT transport.
No npm dependency/version change; no GitHub Actions or automated code
review. The existing full compiled `dist` release and rollback remain
protected by the Portal's reviewed source-manifest trust catalog.

**Deferred, individually audited upstream candidates:**

- `f7ab60e0` invalid globs: distinguish ripgrep syntax failures from
  empty file searches. The upstream patch depends on `filePattern`
  matcher behavior (`d87b6f23`) absent from this fork; implement
  with its own regression and user-facing outcome review rather than
  copying assumptions.
- `d87b6f23`, `fab89d94`: filePattern/Office-source glob parity,
  including inclusion/exclusion alternatives. Requires multi-source,
  Windows path, and search cancellation tests before integration.
- `977deef4`: prevent node:local calls hanging when a detached process
  outside the tracked process tree retains output pipes. Safety and
  timeout semantics require separate process-tree and detached-child
  acceptance; not combined with a file-search feature patch.
- `fec69812`: validate remote auth backend before restoring persisted
  sessions. Security-sensitive; reconcile with fork's private auth
  gating, session binding and redirect protections before adoption.
- `19aad35a`: MQTT remains disabled; activation requires distinct
  transport privacy, enrollment, logout, and opt-in rollout gates.

**Verification:** TypeScript build and focused literal/large-timeout
tests passed in reused clean isolated scratch worktree. Full suite
receipt: `X:\MCP\scratch\deskcommand-upstream-literal-timeout-full-20261121.log`.
A Git merge must not be conflated with a verified live deployment;
the independent supervisor's full artifact checks, successful MCP
semantic verification, approved Portal catalog pin, and rollback
remain release requirements.

### Final full-suite validation for the literal/timeout backport

- Isolated `npm run build` passed with no TypeScript errors (Node.js
  v24.15.0 on Windows).
- `node test/run-all-tests.js` completed **161/161 test modules
  passed, zero failed**, with five existing environment-specific skips:
  unavailable `/bin/sh` and `/bin/bash`, nonstandard system Chrome path,
  POSIX-only process groups on Windows, and the symlink reporting
  condition. Evidence log:
  `X:\MCP\scratch\deskcommand-upstream-literal-timeout-full-20261121.log`.
- The two new executable regression modules passed in the final suite:
  literal bracket/brace filename matching and ordinary glob behavior;
  explicit timeout values of 2,147,483,648 and 3,000,000,000 ms safely
  scheduled as 2,147,483,647 ms.
- Source release and deployment remain distinct. Before promotion
  independently verify the merged candidate tree, stage all compiled
  files and known-good rollback, obtain a reviewed Portal manifest pin,
  and require a successful independent supervisor and live MCP probes.

## 2026-11-22: MCP tool annotation compatibility

- Official upstream remains `9a101b17` (v0.3.4); the local fork base is `737ca939`. The 580-file tree diff is not a safe wholesale merge.
- Adapted upstream `8d6d2672`: 15 fork-specific tools with `readOnlyHint: true` now explicitly set `destructiveHint: false`. No handler behavior or write-tool permissions changed.
- Checked Context7 MCP TypeScript SDK documentation against installed `@modelcontextprotocol/sdk ^1.32.1`: annotations are advisory; read-only and destructive hints have distinct defaults. A current docs query returned the SDK schema.
- Added `test/test-tool-annotations-upstream.js` to assert the actual `tools/list` protocol metadata and preserve non-read-only `write_file` semantics.
- Built successfully using Node v24.15.0 in an existing, clean, non-production worktree. Five focused test modules passed, zero failed or skipped: tool annotations, Context7 preflight, conditional tools, native file input, response budget.
- The complete 169-module test run was deliberately terminated after an incomplete early segment. Do not claim full-suite validation.
- AiGentAI ChatGPT and Copilot comparison requests were accepted but both timed out with unknown outcomes; no independent provider recommendation is verified and no duplicate was submitted.
- No package-version bump, service restart, production deployment, or GitHub Actions run was performed by this backport.

## 2026-11-22: media attribution and search runtime (separate backport cohort)

- Baseline fork main: `026305af7987cccc8990292c0046057d5c671e28`; official upstream: `9a101b17` (v0.3.4).
- Adapted upstream `a87cd4b1045d`: `read_multiple_files` now inserts a per-file text header ahead of image/PDF blocks and keeps the existing header for text content. No file bytes or structured schemas were changed.
- Reused upstream's actual `test/test-read-multiple-files.js` fixture to verify two distinguishable images, a missing file, a PDF page and a text file are attributable to their paths.
- Partially adapted `4976a3e178ff`: on ripgrep close/error, record a terminal timestamp and stop reported runtime from growing on subsequent pagination and list requests. The fork already refreshed `lastReadTime` for negative-offset tail reads; do not re-backport or claim that behavior was missing.
- Added `test/test-search-frozen-runtime.js`, which runs ripgrep in an isolated temporary profile, verifies completed elapsed time is stable, and verifies tail reads keep a session retrievable.
- Context7 review: Model Context Protocol TypeScript SDK v1.x permits ordered, mixed text/image content blocks. We preserved the fork's model-facing and UI-preview payload separation.
- Node v24.15.0 local build passed; nine targeted search/file/schema/stdio/budget tests passed, zero failed/skipped. No full-suite claim, no production deployment.
- Deferred `1cf3335b0161` unified search outcome states because they require coordinated changes to `search-manager.ts`, `search-handlers.ts`, `structured-content.ts` and output schemas, plus failure/partial/stop/timeout regressions. Do not merge an isolated text-only subset.

### Independent Copilot review and follow-up

- Copilot's pinned-HEAD review of candidate `68094ed0` completed with source-access evidence but no executed tests. Three test/attribution gaps were accepted and repaired before merge.
- PDF media blocks now receive per-page text headers containing their source file and `<!-- Page: N -->` markers. Empty-page/zero-page responses retain a file-level header.
- `test-read-multiple-files.js` now generates a two-page embedded-PNG PDF using the project's `pdf-lib` dependency and checks image placement relative to both page headers. This exercised actual PDF parsing on Windows.
- `test-search-terminal-races.js` injects `ChildProcess` error/close sequences and tests frozen runtime after both orders, including when partial results existed.
- The new race test first failed on a real bug: a later close had cleared `isError` after a genuine process error whenever results existed. A dedicated `processError` flag now preserves that hard error.
- No media bytes, unmanaged PID behavior, auth trust, process launching, or production deployment changed.

## 2026-11-22: write/read line count consistency

- Fork baseline main `f701e1cb`, upstream `9a101b17`. Backport target upstream `9f06ff8cc49e` (write_file logical line count).
- The upstream regression was run **before edits** and failed in all three cases: trailing newline (50 reported as 51), over-limit count (51 reported as 52), and mixed CR/LF (4 reported as 3).
- Adapted beyond the upstream patch: the fork's shared `TextFileHandler.countLines` also ignored lone carriage returns, unlike `splitLinesPreservingEndings`. It now counts LF, CRLF and lone CR without allocating an array of split lines. Empty content still yields 0, trailing line breaks do not add a phantom line.
- `handleWriteFile` and UTF-8 `handleReceiveFile` now use that shared helper. Existing binary receive behavior, hashes, filenames and structuredContent types remain unchanged.
- Extended upstream `test-write-file-line-count.js` to assert helper boundary cases and `receive_file` structured lineCount. Four isolated test modules passed (write-line-count, file-output-contracts, native-file-input, negative-offset-readfile), zero failures/skips, including a successful Node v24 build.
- AiGentAI ChatGPT/Copilot source-review requests were attempted. Copilot failed pre-submission; ChatGPT reported unknown-outcome timeout. Neither review was verified, and the unknown-outcome request was not resent.
- No GitHub Actions run requested. No production deployment or package version change.

## 2026-11-22: upstream search-outcome semantics (separate selective cohort)

- Baseline fork main `098cd6af97add2903df086cc6d8a6de86abf8240`, upstream `9a101b17`. Source target `1cf3335b0161` (outcome reporting, not wholesale upstream search-manager replacement).
- Added the six terminal outcomes `completed`, `timed_out`, `stopped`, `max_results`, `partial`, `failed`; result reads and session listings retain the prior page, cursor, memory-bounds and elapsed-time contracts. Stop and time-limit termination are explicitly tagged before signalling.
- A configured max-results threshold that was reached is conservatively labeled `max_results`: this indicates possible truncation, not proof that further matches actually exist. A search with skipped oversized lines or ripgrep code 2 is `partial`, except invalid regex/arguments errors which are `failed`. An unexpected nonzero exit with retained matches is `partial`, preserving the available evidence.
- Updated `start_search`, `get_more_search_results`, `list_searches` text, structured content parser and output schemas together so terminal outcomes are neither silently rewritten as generic `COMPLETED` nor omitted from machine-readable responses. Preserve result bodies when incomplete.
- A real ChildProcess error remains `failed` even if a later close is observed, preserving PR24's error-race fix. Completed searches cannot be stopped retroactively.
- Added `test/test-search-outcome-fork.js` (six outcomes, stopped-session idempotency, malformed regex, oversized lines, error race, all three structured search surfaces) and `test/test-search-outcome-real-rg.js` (actual clean, result-capped and invalid-regex ripgrep searches).
- Context7 consulted for @modelcontextprotocol/sdk version 1.32.1 outputSchema + structuredContent behavior. Local Node24 build and 12 selected search tests passed with 0 failures and 0 skipped; separate real-ripgrep integration passed.
- The AiGentAI Copilot request reached response observation but returned an unknown-outcome timeout; ChatGPT timed out at send-action-started with unknown outcome. Neither was accepted as a completed reviewer response and neither was duplicated.
- No GitHub Actions, full suite, production restart, deployment, or unsafe cross-volume move was undertaken. Immutable production release gates remain separate.
- Final scoped acceptance run: **16 selected modules passed; 0 failed, 0 skipped**, including the actual ripgrep outcome test, MCP stdio, 28/26-tool conditional discovery, read-only annotations, search pagination, UTF-8, timeout bounds, error races and the 32 KiB response budget. Local build passed. Full 169-module suite remains unverified.\n
### Office-source lifecycle defect found and repaired before PR26 merge

- Independent source inspection found that the fork's Excel and DOCX searches run asynchronously but ripgrep's `close` event immediately marked the entire search complete. This could falsely certify exhausted results and allow a late Office result to change completed pagination.
- The manager now reserves Office sources before attaching exit listeners, waits for both ripgrep and Office sources to settle, and freezes runtime only at true session completion. An Office parser rejection yields `partial`, not `completed`.
- Explicit stop, timeout and hard process failure forcibly finalize incomplete sessions and ignore late Office results. Office searches without caller timeout now have a 180000ms default bound; simple exact-name fast-path timing is preserved.
- New `test/test-search-office-completion.js` uses controlled Excel/DOCX promises and checks that early ripgrep closure cannot complete a session, rejection marks `partial`, timed-out and stopped sessions cannot be mutated by late data, and active ripgrep + Office cancellation is bounded.
- A broad 20-module run initially had 19 passes and one failure in historical `test-search-code-edge-cases.js`, which waited for the old success-message marker even for `max_results`. The successful-completion message remains compatible, while the test's wait helper now relies on structured `isComplete`/`outcome` instead of interpreting incomplete capped searches as exhaustive. The edge-case module subsequently passed in isolation.
- Final post-repair scoped run: **20 / 20 test modules passed (0 failures, 0 skipped)** on Node v24.15.0. The previously failing edge-case module now passes on clean success, capped results, very short timeouts, long lines, binary/special text and path traversal. Excel handler and Office lifecycle regressions also passed. The full repository-wide suite and live service acceptance remain unverified.\n
## 2026-11-22 (11:47 Central): selective process polling and tree-termination cohort

- Base fork main `d99180f09514951229f58a8792620f2eddf2179d`, upstream `9a101b17`. Adapted the narrow fixes from upstream `1a05e00f8e2e8955b7ddeadb5d3f3cbe9e299420` (incremental polling and cheap tail checks) and `def14b90ab3b1d73d27abebee4aa154fcd4e1100` (retry after a failed force termination); not a whole-file cherry-pick.
- Fork's original `src/terminal-manager.ts` joined up to 50 MiB on every output snapshot and every interaction poll. Snapshot totals now use existing `bufferedChars` and `evictedChars`; `readOutputSince` advances an absolute position and assembles only new retained output, in reverse from line tails, respecting eviction and completed-session transfers. Existing public `getOutputSinceSnapshot` remains compatible.
- `src/tools/improved-process-tools.ts` now uses the incremental read cursor in `interact_with_process`; original exponential backoff, Windows PowerShell 7 enforcement, prompt handling, output budgets and pagination remain. The read-only process-status path checks only the recent 4 KiB instead of joining full session content. Process-state regex scans are bounded to the most recent 4 KiB in `src/utils/process-detection.ts`.
- `forceTerminateAndWait` coalesces only concurrent attempts in a session-identity-keyed `WeakMap`. Every settled attempt is removed, so failed terminations are retryable; PID reuse is not an alias. Existing protected PID and unmanaged-PID boundaries remain under `terminateProcessTree`.
- Consulted Context7 Node.js v24 child-process lifecycle docs before editing; `subprocess.killed` is not proof of process exit. No unsafe assumption about kill success used.
- New tests: `test/test-process-incremental-output.js` (no full-buffer join, 1200 idle polls, appended last line, eviction, 6 MiB buffer, stale completion hint), and `test/test-termination-single-flight.js` (3 concurrent Windows kills share a verified tree termination; missing taskkill + ineffective fallback produces failure; second attempt succeeds).
- Local Node v24 build and 16 scoped test modules passed, 0 failed; one platform-inapplicable macOS/Linux-only check was skipped on Windows. Covers process trees, start/finish, stdout/stderr inheritance, read pagination, 32 KiB response limits, 28/26-tool conditional MCP discovery and safety admission identities.
- AiGentAI ChatGPT/Copilot reviews were requested once per provider, but each reported an unknown-outcome timeout. Neither counts as a completed independent review and neither was resubmitted.
- The full repository-wide suite, Linux/macOS behavior, quantitative production CPU measurements and live release acceptance are not verified. No GitHub Actions, deploy, restart or production bridge ownership change.

### PR27 independent Copilot P1 finding, repaired before merge

- Copilot completed an actual-source review of PR #27 initial HEAD `3ed7345531afa22e31a96a4f8266255dee20d8cd`; it reported P1 PID reuse because an output cursor tracked only PID + bytes, unlike the session-keyed termination WeakMap. P2 requested stronger real-process transition tests. No P0 finding.
- The output snapshot and every subsequent incremental read cursor now carry the session's immutable `generation`; `readOutputSince` rejects a mismatched generation even if the OS has reused the same PID. The public snapshot lookup also uses this identity check; the old internal integration fixture's explicit cursor was upgraded to include its captured generation.
- Added an adversarial fixture: capture generation 1 under PID X, replace it with generation 2 containing unrelated output, assert that both incremental and compatibility reads from generation 1 return null and do not expose the new process's bytes.
- Node v24 build, the new cursor regression, the real kill/retry regression and a post-fix **16 / 16** targeted suite passed; 0 failed, with one macOS/Linux-only platform check skipped.
- Independently ran `test/integration/terminal-output-buffer-leak.js`: real 576 MiB streamed; 49 MiB retained under the 50 MiB cap; maximum measured event-loop stall **31 ms**, exit code 0. This is isolated test evidence, not a claim of production CPU performance.

### 2026-11-22 PR28: post-merge interaction generation TOCTOU remediation

- Copilot independently reviewed PR27 final HEAD `0378493716a280712ed64b8561a63e617b59687d` and confirmed the output cursor-generation P1 was fixed, but found a further P1: `interactWithProcess` took a generation-bearing snapshot and then called `sendInputToProcess`, which separately looked up the PID without binding to the captured generation. A recycled PID could receive commands meant for the old session before output reads rejected the new identity.
- Corrected `TerminalManager.sendInputToProcess` with optional `expectedGeneration`: after resolving the current active session it fails closed on generation mismatch. The identity check and `stdin.write` execute in the same synchronous JavaScript turn, without an intervening await. `interactWithProcess` always supplies the snapshot generation. The legacy direct input calls remain backward-compatible and unchanged.
- Extended `test/test-process-incremental-output.js` with two proofs: direct mismatched generation rejects a write, and the full interaction handler is forced to experience a PID replacement between capture and send, rejecting the interaction without leaking its input.
- Repaired the stress integration fixture's completed-before-snapshot fallback to recover the generation from `getSessionStateVersion(pid)`, instead of passing an invalid generation. Local Node24 build, focused generation regression, inherited-stdio regression and the real 576 MiB output flood passed; retained 49 MiB under a 50 MiB cap; event-loop stall 26ms in this run.
- No live deploy, service restart, GitHub Actions or framework version change. This is a post-merge source-only correction to the prior PR27.

## 2026-11-22: retire two failed v0.3.0 integration worktrees after selective salvage

- Historical base `4f0ed60a44e76524c97e9abcfed8f741a508c567`; the abandoned `-X theirs` evaluation still held MERGE_HEAD `67694caa7f54ee2ca70d455ed730be231ed3fbfc`, 265 staged paths and 22 unstaged paths (267 status entries), and 132 recorded TypeScript diagnostics. Its complete effective working-tree patch was archived to `X:\MCP\archives\DesktopCommanderMCP\upstream-v030-theirs-eval-20261122` before cleanup.
- Archive replay checked against the exact historical base using a temporary Git index and reconstructed tree `c79b13f5a76f8710de658e14db51190ca497dbc6`. Combined patch SHA-256: `ABC250CB2DEA814473D5E8A53ABCCB7A5FD514C02C760B9BC30971D710759228`. Separate staged and unstaged binary patches preserve the merge's distinct phases. Never merge this historical tree wholesale.
- The other dirty worktree had one untracked note only. Its full `INTEGRATION_STATUS.md` is preserved here as `docs/integration/upstream-v030-historical-evaluation-20261014.md`, explicitly labeled obsolete.
- Independently replayed five self-contained historical upstream regressions against modern main: line breaks in large reads; overlapping replacement counts; folder metadata; rename retry; invalid PDF page deletion. Four initially failed in the current fork and were repaired with small, coherent changes to `src/utils/files/text.ts`, `src/tools/edit.ts`, `src/tools/filesystem.ts`, and `src/tools/pdf/manipulations.ts`. All five recovered tests pass.
- The reverse-tail scanner now locates CR/LF/CRLF byte boundaries across chunks and uses Node readline's established decoding/lifecycle path; `edit_block` counts non-overlapping replacements; `get_file_info` returns directory facts without invoking extension-based file handlers; and invalid PDF page indexes reject the edit before page removal/writing. The legacy PDF creation fixture no longer relies on silently ignoring an invalid second delete.
- Node 24 build + **24 / 24 relevant file, edit, rename, PDF and offset test modules passed** (0 failed, 0 skipped). Context7 Node v24 readline and pdf-lib docs were consulted. Full repository suite and live deployment gates are not claimed.
- Cleanup gate: only after this selective PR is merged and main synced should the verified historical worktrees and their now-merged branch refs be removed. The patch archive remains the recovery source.

## 2026-11-22: historical process-schema regression salvage

- Compared current fork main `e07c0b8b6867a7616f50bebcf107d550ef939438` with two clean divergent August worktrees: `fix/start-process-admission-20260807` (1 unique commit) and `reliability/process-hardening-20260816` (6 old commits). Branch patch-id comparison confirms old interactive-input validation and command-parser recursion commits already have exact equivalents in main. The other old commits are not automatically safe to cherry-pick; current main separately implements SSRF checks, recovery, admission throttling and subprocess limits.
- Recovered the missing `test/test-schema-regressions.js` from historical `b6687fba`. It initially failed: read_process_output, interact_with_process, and force_terminate accepted invalid PID 0 at input-schema validation. `kill_process` already enforced a positive, bounded integer.
- Copilot's exact-HEAD review caught a P1 before merge: force_terminate and interact_with_process legitimately accept negative virtual node:local PIDs beginning at -1000. Corrected the design: read_process_output and kill_process require positive OS PIDs (1–2147483647), while interact and force_terminate use a Zod union accepting either the positive OS range or safe integers <= -1000. Unknown negative virtual IDs fail closed before any OS process path. Strengthened invalid cases with NaN, Infinity, -1, -999 and over-32-bit values, and validated a real node:local start/interact/terminate lifecycle. Existing client tool schemas are generated from the same Zod definitions.
- Context7 consulted for Zod 3.24.2 and Node 24 child_process spawn failure semantics. Local Node 24 build + 16 targeted process/schema/MCP modules passed, 0 failed, 0 skipped, including 28 regular / 26 app tools, response budgets, managed termination and idle cursor tests. Full suite and live release not claimed.
- Standing safety boundary: old start-process classifier/redirect and old remote/dependency cohorts require semantic review; no blind merges, no replacement of production services, and no GitHub Actions.

- The second legacy security regression cohort exposed a stale test fixture (not an actual bypass): `test-blocklist-bypass.js` mocked `captureOutputSnapshot` as null and nevertheless expected harmless stdin to be submitted, contrary to the newer fail-closed session-generation contract. Changed mock to a valid generation-bearing snapshot and added an assertion that null snapshots reject even benign input without writing. All command-parser blocked-input cases then pass; no runtime policy weakened.
