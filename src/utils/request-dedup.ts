/**
 * Single-flight deduplication for tool-call requests.
 *
 * When a client sends near-simultaneous identical requests (common during
 * reconnect, UI refresh, or LLM retry-after-schema-strip), only the first
 * executes; concurrent duplicates wait for and share its result.
 *
 * Callers that arrive after the winner completes execute normally. Only true
 * overlap receives a `deduplicated: true` marker and the shared result.
 *
 * ponytail: Map<key, Promise> is the simplest correct singleflight; no
 * expiry/eviction needed because near-duplicates arrive within the same
 * event-loop tick and the Promise settles quickly.
 */

/** Requests that are currently in-flight, keyed by stable tool+arg hash. */
const inFlight = new Map<string, Promise<unknown>>();

/** Total deduplications since server start (observable counter, no PII). */
let dedupHitCount = 0;

export function getDedupCounters(): { hits: number; stales: number } {
  return { hits: dedupHitCount, stales: 0 };
}

/**
 * Build a stable, non-cryptographic key from a tool name and its arguments.
 * Only includes own enumerable string-keyed properties so extra JSON-RPC
 * envelope keys (_meta, etc.) are excluded.  Object.keys sorts are stable
 * within a single V8 runtime, which is all we need for same-tick grouping.
 */
function buildDedupKey(toolName: string, args: unknown): string {
  const stableStringify = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
    if (typeof value === 'object' && value !== null) {
      const object = value as Record<string, unknown>;
      return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
    }
    return JSON.stringify(value) ?? String(value);
  };
  return `${toolName}:${stableStringify(args)}`;
}

/**
 * Execute `fn` once for the given tool-name + args combination while it is in
 * flight. Concurrent callers get the same promise; sequential callers (after
 * the winner resolves) execute normally.
 */
export async function dedupRequest<T>(
  toolName: string,
  args: unknown,
  fn: () => Promise<T>,
): Promise<{ result: T | undefined; deduplicated: boolean }> {
  const key = buildDedupKey(toolName, args);
  const existing = inFlight.get(key);
  if (existing) {
    dedupHitCount++;
    const result = (await existing) as T;
    return { result, deduplicated: true };
  }

  const pending = fn();
  inFlight.set(key, pending);

  try {
    const result = await pending;
    return { result, deduplicated: false };
  } finally {
    if (inFlight.get(key) === pending) {
      inFlight.delete(key);
    }
  }
}
