import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTestEnv, isTestHome } from './helpers/test-env.js';

if (!isTestHome()) {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [import.meta.filename], {
      env: isolated.env, stdio: 'inherit', timeout: 45_000,
    });
    assert.equal(child.status, 0, child.error?.message);
  } finally { isolated.cleanup(); }
} else {
  const { server } = await import('../dist/server.js');
  const { toolHistory, toolRequestCorrelation } = await import('../dist/utils/toolHistory.js');
  const { usageTracker } = await import('../dist/utils/usageTracker.js');
  const { terminalManager } = await import('../dist/terminal-manager.js');
  const handler = server._requestHandlers.get('tools/call');
  const originalWrite = process.stderr.write;
  const originals = Object.fromEntries(['trackSuccess', 'trackFailure', 'shouldShowOnboarding', 'shouldPromptForFeedback']
    .map(key => [key, usageTracker[key]]));
  const receipts = [];
  process.stderr.write = function (chunk, ...args) {
    try {
      const entry = JSON.parse(String(chunk));
      if (entry.event === 'tool_response_size') {
        receipts.push(entry);
        return true;
      }
    } catch {}
    return originalWrite.call(this, chunk, ...args);
  };
  usageTracker.trackSuccess = async () => {};
  usageTracker.trackFailure = async () => {};
  usageTracker.shouldShowOnboarding = async () => false;
  usageTracker.shouldPromptForFeedback = async () => false;
  const history = () => toolHistory.getRecentCalls({ maxResults: 1000 });
  const call = (name, args = {}, meta) => handler({ method: 'tools/call', params: {
    name, arguments: args, ...(meta ? { _meta: meta } : {}),
  } }, {});
  const id = 'a'.repeat(32);
  try {
    for (const meta of [null, {}, { sanitycloud_request_id: 'private-path/token', sanitycloud_attempt: 1 },
      { sanitycloud_request_id: 'A'.repeat(32) }, { sanitycloud_request_id: id + '\n' }]) {
      const correlation = toolRequestCorrelation(meta);
      assert.match(correlation.request_id, /^[0-9a-f]{32}$/);
      assert.equal(correlation.attempt, 0);
      assert.equal(Object.keys(correlation).length, 2);
    }
    assert.deepEqual(toolRequestCorrelation({ sanitycloud_request_id: id, sanitycloud_attempt: 1 }),
      { request_id: id, attempt: 1 });
    assert.equal(toolRequestCorrelation({ sanitycloud_request_id: id, sanitycloud_attempt: '1' }).attempt, 0);

    let before = history().length;
    const badArgs = { secret: 'argument-private-marker-界' };
    const failure = await call('unknown_fixture_tool', badArgs, { sanitycloud_request_id: id, sanitycloud_attempt: 1 });
    assert.equal(failure.isError, true);
    assert.equal(history().length, before + 1);
    assert.deepEqual(history().at(-1).arguments, badArgs, 'existing local argument retention stays intact');
    assert.equal(history().at(-1).outcome, 'error');
    assert.equal(history().at(-1).attempt, 1);
    assert.equal(receipts.at(-1).argument_bytes, Buffer.byteLength(JSON.stringify(badArgs)));
    assert.equal(receipts.at(-1).request_id, id);
    assert.equal(receipts.at(-1).record_type, 'request_completion');
    assert(Date.parse(receipts.at(-1).timestamp) >= Date.parse(receipts.at(-1).received_at));

    usageTracker.trackSuccess = async () => { throw new Error('private-exception-marker'); };
    before = history().length;
    const thrown = await call('list_sessions');
    assert.equal(thrown.isError, true);
    assert.equal(history().length, before + 1, 'thrown execution is recorded exactly once');
    assert.equal(history().at(-1).output.isError, true);
    assert.equal(history().at(-1).outcome, 'handler_exception');
    assert.equal(receipts.at(-1).outcome, 'handler_exception');
    assert.notEqual(receipts.at(-1).request_id, id, 'prior call metadata cannot leak into a direct call');

    usageTracker.trackFailure = async () => { throw new Error('private-tracker-marker'); };
    before = history().length;
    await assert.rejects(call('list_sessions'));
    assert.equal(history().length, before + 1, 'failure reporting failure still retains execution');
    assert.equal(history().at(-1).output.isError, true);
    assert.equal(receipts.at(-1).outcome, 'request_exception');
    assert.equal(receipts.at(-1).response_bytes, null, 'uncaught JSON-RPC errors have no measured tool response');
    usageTracker.trackFailure = async () => {};

    let release, entered;
    const blocked = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    usageTracker.trackSuccess = async () => { entered(); await blocked; };
    before = history().length;
    const receiptStart = receipts.length;
    const first = call('get_config', {}, { sanitycloud_request_id: 'b'.repeat(32) });
    await started;
    const second = call('get_config', {}, { sanitycloud_request_id: 'c'.repeat(32) });
    await new Promise(resolve => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    assert.equal(history().length, before + 1, 'coalesced reads have one actual execution');
    assert.equal(receipts.length, receiptStart + 2, 'each coalesced received request has a completion');
    assert.deepEqual(receipts.slice(-2).map(r => r.execution_deduplicated).sort(), [false, true]);
    assert.deepEqual(receipts.slice(-2).map(r => r.request_id).sort(), ['b'.repeat(32), 'c'.repeat(32)]);
    usageTracker.trackSuccess = async () => {};

    before = history().length;
    await Promise.all([0, 1].map(() => call('set_config_value', { key: 'telemetryEnabled', value: false })));
    assert.equal(history().length, before + 2, 'separate mutations are never coalesced');
    assert(receipts.slice(-2).every(r => !r.execution_deduplicated));

    before = history().length;
    await call('get_config', {}, { sanitycloud_request_id: id, sanitycloud_attempt: 0 });
    await call('get_config', {}, { sanitycloud_request_id: id, sanitycloud_attempt: 1 });
    assert.equal(history().length, before + 2, 'sequential retry attempts remain separate executions');
    assert.deepEqual(history().slice(-2).map(r => [r.request_id, r.attempt]), [[id, 0], [id, 1]]);

    terminalManager.completedSessions.set(987654, { outputLines: ['first', 'second'], lastReadIndex: 0,
      exitCode: 7, startTime: new Date(), endTime: new Date(), evictedLines: 0, evictedChars: 0 });
    const page1 = await call('read_process_output', { pid: 987654, length: 1, timeout_ms: 0 });
    const page2 = await call('read_process_output', { pid: 987654, length: 1, timeout_ms: 0 });
    assert.notDeepEqual(page1, page2, 'stateful process output still advances');
    assert.equal(receipts.at(-1).exit_code, 7);
    assert.equal(history().at(-1).exit_code, 7);
    assert(!JSON.stringify(receipts).includes('argument-private-marker'));
    assert(!JSON.stringify(receipts).includes('private-exception-marker'));
    assert(!JSON.stringify(receipts).includes('private-tracker-marker'));
    assert(receipts.every(r => typeof r.argument_bytes === 'number' && r.duration_ms >= 0));
    await toolHistory.cleanup();
    const records = fs.readFileSync(path.join(toolHistory.getStats().historyFile), 'utf8').trim().split('\n').map(JSON.parse);
    assert.equal(records.length, history().length, 'one durable line per actual execution');
    console.log('PASS: completion correlation/privacy, failure history, singleflight, retry attempts, stateful output, disk flush');
  } finally {
    process.stderr.write = originalWrite;
    Object.assign(usageTracker, originals);
    await toolHistory.cleanup();
  }
}
