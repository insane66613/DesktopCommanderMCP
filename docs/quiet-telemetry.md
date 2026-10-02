# Quiet diagnostics and process wait timing

Desktop Commander keeps console diagnostics on local stderr. Initialization does
not replay startup logs to the MCP client. This prevents routine configuration,
search and process diagnostics from becoming extra `notifications/message`
traffic alongside tool results.

Clients that need MCP diagnostic messages can explicitly request
`logging/setLevel`. Explicit logger messages at or above that severity are then
forwarded; console output and additional diagnostic data remain local. Existing
Cline/VS Code notification suppression still applies. Tool results and progress
notifications are unaffected.

The local `tool_response_size` JSON record includes the tool name, serialized
UTF-8 response bytes, final-budget compaction flag, `duration_ms`, `is_error`, and
`process_page_limited`. It contains no tool arguments or output. The pagination
flag is separate from final 32 KiB compaction: an ordinary 8 KiB process text page
can appear in both compatibility representations and serialize to about 17 KiB.
These byte measurements do not establish model tokens or billed usage.

Settled process launches clear their fallback timers. A command that finishes
early no longer retains a timer until its requested launch timeout, and delayed
callbacks cannot mark the settled session blocked. Empty-output reads cap each
poll interval to the remaining requested wait. These changes do not kill the
underlying process or retry a tool operation.

For traffic diagnosis, count bridge ingress, completed tool-response metrics and
transport dispatch records separately. One logical call can produce multiple
dispatch log records. Queue latency must be measured at ingress, not inferred
from response completion counts. Repeated tool names alone do not establish
duplicate arguments, a retry loop or the requesting consumer.
