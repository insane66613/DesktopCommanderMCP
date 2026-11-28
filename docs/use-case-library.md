# Desktop Commander use-case library

These prompts use the MCP tools available in the current Desktop Commander server.
Replace bracketed values with your local paths or project names. Every example
assumes Desktop Commander is connected to your AI client and has access to the
files involved.

## 1. Explore an unfamiliar codebase
> Review the repository at [absolute path]. Summarize entry points, source
> modules, tests, build scripts, and architectural dependencies. Read before
> proposing changes. Include file-path evidence.

**Tools:** `list_directory`, `read_file`, `start_search`.
**Verify:** The analysis names existing source files and relevant tests.

## 2. Implement a small feature with a regression test
> In [repository path], identify the smallest compatible change for [feature].
> Read the affected files, write a failing regression test, implement the
> change, and run focused tests. Do not modify unrelated working changes.

**Tools:** `read_file`, `edit_block`, `start_process`.
**Verify:** Before/after test evidence and a bounded diff.

## 3. Organize downloads without losing files
> Inventory [downloads path], report suggested destinations by file type,
> and flag collisions or ambiguous names. Do not move anything until I
> approve the proposed map.

**Tools:** `list_directory`, `get_file_info`, `move_file`.
**Verify:** Confirm each destination and record files left untouched.
## 4. Analyze a spreadsheet or CSV
> Examine [absolute data-file path]. Summarize column meanings, missing data,
> duplicates, and meaningful patterns. Explain formula values separately
> from formula definitions. Do not overwrite the source.

**Tools:** `read_file`, `start_process`.
**Verify:** Show row counts, missing-value counts, and reproducible steps.
**Note:** Cached spreadsheet formula results are not recalculated automatically.

## 5. Inspect a running development service
> Check the service at [host/port], identify its executable and process,
> inspect recent bounded output, and perform a real request. Report the
> observed response; don't infer readiness from a listening port alone.

**Tools:** `list_processes`, `start_process`, `read_process_output`.
**Verify:** Process identity, actual request/response, and exit codes.

## 6. Review recent work after a context reset
> Use recent tool history in compact mode to identify files changed,
> commands executed, and unfinished tasks. Cross-check with repository
> status and original test logs before making further edits.

**Tools:** `get_recent_tool_calls`, `start_process`, `read_file`.
**Verify:** Exact repo HEAD, status, and result receipts.

## 7. Read and edit a Word document carefully
> Read [document.docx] as an outline. Locate the exact paragraph or table
> to change, inspect the source XML, then make only that edit. Verify that
> surrounding sections, headers, and tables remain intact.

**Tools:** `read_file`, `edit_block`.
**Verify:** Reopen the saved document and compare affected text.
## 8. Extract and summarize information from a PDF
> Read [file.pdf], identify the relevant pages, and summarize the requested
> facts with page references. Distinguish unreadable or image-only pages
> from evidence that information is absent.

**Tools:** `read_file`.
**Verify:** Page-specific citations and a clear uncertainty note.

## 9. Audit search results across a large repository
> Search [root path] for [pattern]. Request paginated results and track
> completion status. Report skipped lines, truncation, or incomplete
> searches; don't call a partial result exhaustive.

**Tools:** `start_search`, `get_more_search_results`, `list_searches`.
**Verify:** A completed search outcome or explicitly reported limitations.

---

### Operational rules

- Use absolute paths. Preserve unsaved or uncommitted work.
- Treat tool success, build success, and live deployment success as different
  kinds of evidence.
- Prefer preview and explicit approval before high-impact bulk mutations.
- Verify outcomes with readback, tests, or actual service requests.
- If a tool is not available in your connected client, inspect `tools/list`
  rather than assuming the current host exposes every feature.

Source reconciliation: the historical `feature/use-case-library` and
`feature/use-cases-subpage` branches provided prompts and an HTML site.
The current repository no longer contains that website's shared HTML/CSS/JS
shell, so this native GitHub-readable guide replaces the orphaned page.
