# Native ChatGPT file transfer

`receive_file` accepts a native ChatGPT file reference as its preferred input.
ChatGPT supplies a temporary `download_url` and `file_id`; DeskCommand streams
the file directly to an explicitly selected absolute local path. The model does
not need to read or base64-encode the file. Binary formats retain their bytes.

The tool declares `_meta["openai/fileParams"] = ["file"]` using the
[official native file-input contract](https://developers.openai.com/plugins/reference#file-apis).
The file object declares `download_url`, `file_id`, `mime_type` and `file_name`;
only the first two are required. File availability depends on the calling client
resolving the reference. A sandbox path alone is not a downloadable URL; do not
invent a URL or repeatedly retry an unresolved reference.

Example resolved tool arguments:

```json
{
  "path": "C:\\Users\\user\\Downloads\\report.xlsx",
  "file": {
    "download_url": "https://authorized-file-host.example/temporary-download",
    "file_id": "file-provided-by-the-client",
    "mime_type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "file_name": "report.xlsx"
  }
}
```

The destination uses existing allowed-directory checks. File name and MIME
metadata do not choose the destination. Native input refuses existing files by
default; add explicit `mode: "rewrite"` to replace a regular file after a
successful download. `mode: "append"` is rejected for native files. Optional
`createParentDirectories` creates allowed destination directories. Optional
`expectedSha256` validates the exact downloaded bytes before publication; every
successful result reports SHA-256 and byte count even without an expected hash.

Downloads are limited to 100 MiB, 45 seconds total, and three redirects. Each hop
requires public HTTPS on port 443 without URL credentials. Validated DNS results
are pinned to the connection; local/private addresses and mixed public/private
DNS answers are rejected. Requests ask for identity encoding and reject other
content encodings. No caller authentication headers or cookies are forwarded.

Bytes are written to a random same-directory temporary file. Hash, size and
destination checks precede an atomic commit. Errors or cancellation clean up
temporary files and preserve an existing destination. The helper rechecks path
policy and symlinks before commit; portable Node filesystem APIs cannot eliminate
a malicious local directory swap between the final check and filesystem syscall.
Native no-overwrite publication requires filesystem hardlink support (available
on normal NTFS volumes); unsupported filesystems fail rather than overwrite.

Signed URLs are redacted from tool-call logs and execution history. Error
responses do not include network exception text or download links. File mutation
is never automatically replayed by the bridge: after an uncertain disconnect,
inspect the destination and checksum before trying again. Cancellation arriving
after an atomic commit cannot undo the completed write.

Existing `content` callers remain supported with UTF-8 or binary-safe base64.
Supply exactly one of `file` and `content`; `encoding` applies only to inline
content. Prefer native file input for artifacts to avoid base64 expansion and
large tool arguments. Clients that cache tool schemas may need to refresh the
DeskCommand connection or start a fresh chat before native input is discoverable.
