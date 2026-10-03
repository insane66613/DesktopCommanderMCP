import type { ServerResult } from '../types.js';

export const MAX_TOOL_RESPONSE_BYTES = 32 * 1024;
export const DEFAULT_PROCESS_PAGE_BYTES = 8 * 1024;
export const MAX_PROCESS_PAGE_BYTES = 8 * 1024;

export function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

/** Bound serialized UTF-8, including JSON escaping, without splitting a surrogate pair. */
export function boundedText(text: string, maxBytes: number): string {
  if (serializedBytes(text) <= maxBytes) return text;
  let low = 0;
  let high = Math.min(text.length, maxBytes);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (serializedBytes(text.slice(0, mid)) <= maxBytes) low = mid;
    else high = mid - 1;
  }
  if (low > 0 && /[\uD800-\uDBFF]/.test(text[low - 1])) low--;
  return text.slice(0, low);
}

/** Final safety net after enrichment: never return unbounded duplicate fields or media. */
export function budgetToolResponse(result: ServerResult): ServerResult {
  const originalBytes = serializedBytes(result);
  if (originalBytes <= MAX_TOOL_RESPONSE_BYTES) return result;
  const notice = `[Response limited to ${MAX_TOOL_RESPONSE_BYTES} bytes; original ${originalBytes} bytes. Data omitted from this response. Use smaller pages/ranges to retrieve it; do not repeat a successful mutation.]`;
  const fields = result.structuredContent as Record<string, unknown> | undefined;
  const fileTransfer = (fields?.encoding === 'base64' || fields?.encoding === 'utf8') && typeof fields?.returnedBytes === 'number';
  const omitPayload = fileTransfer || fields?.encoding === 'base64' || fields?.fileType === 'image';
  const firstText = omitPayload ? '' : result.content.find(item => item.type === 'text')?.text ?? '';
  for (let fieldBytes = 2048; fieldBytes >= 16; fieldBytes /= 2) {
    const structured: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(result.structuredContent ?? {})) {
      if (serializedBytes(key) > 256 || Object.keys(structured).length >= 64) continue;
      if (key === 'content' && omitPayload) continue;
      structured[key] = typeof value === 'string' ? boundedText(value, fieldBytes)
        : Array.isArray(value) ? [] : value !== null && typeof value === 'object' ? {} : value;
    }
    if (omitPayload) Object.assign(structured, { truncated: true, returnedBytes: 0 });
    const compact: ServerResult = {
      content: [{ type: 'text', text: `${notice}${fileTransfer ? ' Request a smaller maxBytes for the file transfer.' : ''}\n${boundedText(firstText, fieldBytes * 4)}` }],
      ...(result.structuredContent ? { structuredContent: { ...structured, responseTruncated: true } } : {}),
      ...(result.isError !== undefined ? { isError: result.isError } : {}),
    };
    if (serializedBytes(compact) <= MAX_TOOL_RESPONSE_BYTES) return compact;
  }
  // Only pathological metadata keys can exceed the budget after compaction.
  return { content: [{ type: 'text', text: notice }], ...(result.isError !== undefined ? { isError: result.isError } : {}) };
}
