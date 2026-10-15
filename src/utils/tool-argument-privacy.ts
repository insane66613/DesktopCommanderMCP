/** Temporary file download links are credentials and must not enter local logs. */
export function redactToolArguments(toolName: string, args: unknown): unknown {
  if (toolName !== 'receive_file' || !args || typeof args !== 'object') return args;
  const values = args as Record<string, unknown>;
  if (!values.file || typeof values.file !== 'object') return args;
  return { ...values, file: { ...values.file, download_url: '[redacted]' } };
}
