import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

// Direct execution is safe too: import history only inside an isolated home.
if (!isTestHome()) {
  const testEnv = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
      env: testEnv.env, stdio: 'inherit', timeout: 30_000
    });
    assert.equal(child.status, 0, child.error?.message);
  } finally {
    testEnv.cleanup();
  }
} else {
  const historyDir = path.join(os.homedir(), '.claude-server-commander');
  fs.mkdirSync(historyDir, { recursive: true });
  const oversized = {
    content: [{ type: 'text', text: 'short text' }],
    structuredContent: { payload: 'x'.repeat(20_000) },
    _meta: { payload: 'y'.repeat(20_000) },
    isError: true
  };
  fs.writeFileSync(path.join(historyDir, 'tool-history.jsonl'), JSON.stringify({
    timestamp: new Date().toISOString(), toolName: 'legacy',
    arguments: { secret: 'argument-marker' }, output: oversized, duration: 7
  }) + '\n');
  const { toolHistory } = await import('../dist/utils/toolHistory.js');
  const { handleGetRecentToolCalls } = await import('../dist/handlers/history-handlers.js');
  try {
    const loaded = toolHistory.getRecentCalls({ maxResults: 1 })[0].output;
    assert.ok(Buffer.byteLength(JSON.stringify(loaded), 'utf8') <= 4096);
    assert.equal(loaded.isError, true);
    assert.equal(loaded.structuredContent, undefined);
    assert.equal(loaded._meta, undefined);
    toolHistory.addCall('structured', {}, oversized, 7);
    const stored = toolHistory.getRecentCalls({ maxResults: 1 })[0].output;
    assert.ok(Buffer.byteLength(JSON.stringify(stored), 'utf8') <= 4096);
    assert.equal(stored.isError, true);
    assert.equal(stored.structuredContent, undefined);
    assert.equal(stored._meta, undefined);

    // Fewer than 4096 JS characters, but more than 4096 UTF-8 bytes.
    const unicode = { content: [{ type: 'text', text: '界'.repeat(2000) }] };
    assert.ok(JSON.stringify(unicode).length < 4096);
    toolHistory.addCall('unicode', {}, unicode, 8);
    const capped = toolHistory.getRecentCalls({ maxResults: 1 })[0].output;
    assert.match(capped.content[0].text, /output omitted from history/);
    assert.ok(Buffer.byteLength(JSON.stringify(capped), 'utf8') <= 4096);

    const small = { content: [{ type: 'text', text: 'output-marker' }] };
    toolHistory.addCall('small', { value: 'argument-marker' }, small, 9);
    const summary = await handleGetRecentToolCalls({ maxResults: 3 });
    assert.equal(summary.isError, undefined);
    assert.equal(summary.structuredContent.calls.length, 3);
    assert.equal(summary.structuredContent.text, undefined);
    assert.equal(summary.content[0].text, summary.structuredContent.summary);
    assert.ok(!JSON.stringify(summary).includes('argument-marker'));
    assert.ok(!JSON.stringify(summary).includes('output-marker'));
    for (const call of summary.structuredContent.calls) {
      assert.ok(!('arguments' in call));
      assert.ok(!('output' in call));
      assert.equal(typeof call.success, 'boolean');
    }
    assert.equal(summary.structuredContent.calls[0].success, false);
    const details = await handleGetRecentToolCalls({ maxResults: 1, includeDetails: true });
    assert.deepEqual(details.structuredContent.calls[0].arguments, { value: 'argument-marker' });
    assert.deepEqual(details.structuredContent.calls[0].output, small);
    assert.ok(!details.content[0].text.includes('output-marker'));
    console.log('PASS: compact history, explicit details, UTF-8 cap, legacy structured-output cap');
  } finally {
    await toolHistory.cleanup();
  }
}
