import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchManager } from '../dist/search-manager.js';

const root = await fs.mkdtemp(path.join(path.dirname(fileURLToPath(import.meta.url)), '__timeout_overflow_'));
const nativeTimeout = globalThis.setTimeout;
try {
  await fs.writeFile(path.join(root, 'fixture.txt'), 'fixture');
  for (const timeout of [2147483648, 3000000000]) {
    let scheduled;
    globalThis.setTimeout = (callback, ms, ...args) => {
      if (ms >= 2147483647) {
        scheduled = ms;
        // A deliberately oversized duration is not delegated to Node,
        // preventing an unintended 1ms cancellation in the baseline test.
        return nativeTimeout(callback, Math.min(ms, 2147483647), ...args);
      }
      return nativeTimeout(callback, ms, ...args);
    };
    let started;
    try {
      started = await searchManager.startSearch({
        rootPath: root, pattern: '*.txt', searchType: 'files',
        timeout, earlyTermination: false, maxResults: 100,
      });
    } finally {
      globalThis.setTimeout = nativeTimeout;
    }
    assert.equal(scheduled, 2147483647,
      `timeout_ms=${timeout} scheduled ${scheduled}, which Node would treat as 1ms`);
    assert.ok(started.sessionId);
    console.log(`PASS input_timeout=${timeout} scheduled=${scheduled}`);
  }
} finally {
  globalThis.setTimeout = nativeTimeout;
  searchManager.dispose();
  await fs.rm(root, { recursive: true, force: true });
}
