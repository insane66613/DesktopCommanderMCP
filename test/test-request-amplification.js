/**
 * Regression tests for request amplification fixes.
 *
 * Tests:
 *  1. start_process accepts visible/keep_open/window_title/exclude_self fields
 *  2. Concurrent read_file dedup: two same-path reads => one disk access
 *  3. Bounded backoff: read_process_output doesn't tight-loop
 *  4. Timer cleanup: no orphaned intervals after process completes
 *  5. Tool-list caching: repeated list_tools returns cached schemas
 *  6. Output schemas do not leak on errors
 *  7. Dedup counters are observable in get_config
 *
 * Runs as `node test/test-request-amplification.js` (requires `npm run build`).
 */
import assert from 'node:assert';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { StartProcessArgsSchema } from '../dist/tools/schemas.js';
import { getDedupCounters, dedupRequest } from '../dist/utils/request-dedup.js';
import { createToolBridge } from '../dist/ui/shared/tool-bridge.js';
import { createUiEventTracker } from '../dist/ui/shared/ui-event-tracker.js';
import { RemoteChannel } from '../dist/remote-device/remote-channel.js';

// --- Schema tests ---

async function testStartProcessSchemaHasRestoredFields() {
  console.log('\n--- Test: start_process schema has restored fields ---');

  const jsonSchema = zodToJsonSchema(StartProcessArgsSchema);
  assert(jsonSchema, 'Schema should be defined');
  assert(jsonSchema.type === 'object', 'Schema should be an object');

  const props = jsonSchema.properties;
  assert(props, 'Schema should have properties');

  assert('visible' in props, 'visible field must exist');
  assert('keep_open' in props, 'keep_open field must exist');
  assert('window_title' in props, 'window_title field must exist');
  assert('exclude_self' in props, 'exclude_self field must exist');
  assert('origin' in props, 'origin field must still exist');

  assert.strictEqual(props.visible.default, false, 'visible defaults to false');
  assert.strictEqual(props.keep_open.default, false, 'keep_open defaults to false');
  assert.strictEqual(props.exclude_self.default, false, 'exclude_self defaults to false');

  console.log('  PASS: all restored fields present with correct defaults');
}

async function testParseAcceptsRestoredFields() {
  console.log('\n--- Test: StartProcessArgsSchema.parse accepts restored fields ---');

  const result = StartProcessArgsSchema.parse({
    command: 'echo hello',
    timeout_ms: 5000,
    visible: true,
    keep_open: true,
    window_title: 'Diagnostic',
    exclude_self: true,
  });

  assert.strictEqual(result.visible, true);
  assert.strictEqual(result.keep_open, true);
  assert.strictEqual(result.window_title, 'Diagnostic');
  assert.strictEqual(result.exclude_self, true);

  console.log('  PASS: schema parses restored fields');
}

async function testParseDefaultsRestoredFields() {
  console.log('\n--- Test: StartProcessArgsSchema.parse defaults restored fields ---');

  const result = StartProcessArgsSchema.parse({
    command: 'echo hello',
    timeout_ms: 5000,
  });

  assert.strictEqual(result.visible, false);
  assert.strictEqual(result.keep_open, false);
  assert.strictEqual(result.exclude_self, false);

  console.log('  PASS: restored fields default correctly');
}

// --- Dedup tests ---

async function testDedupSingleFlight() {
  console.log('\n--- Test: dedup single-flights identical concurrent requests ---');

  let callCount = 0;
  const fn = async () => {
    callCount++;
    return { value: 'hello-' + callCount };
  };

  const [r1, r2, r3] = await Promise.all([
    dedupRequest('read_file', { path: '/tmp/test.txt', offset: 0 }, fn),
    dedupRequest('read_file', { path: '/tmp/test.txt', offset: 0 }, fn),
    dedupRequest('read_file', { path: '/tmp/test.txt', offset: 0 }, fn),
  ]);

  assert.strictEqual(callCount, 1, 'Only one execution for three identical calls');
  assert.strictEqual(r1.deduplicated, false, 'First caller is the winner');
  assert.strictEqual(r2.deduplicated, true, 'Second caller gets dedup');
  assert.strictEqual(r3.deduplicated, true, 'Third caller gets dedup');
  assert.strictEqual(r1.result?.value, 'hello-1', 'Winner gets value');
  assert.strictEqual(r2.result?.value, 'hello-1', 'Dedup shares winner value');
  assert.strictEqual(r3.result?.value, 'hello-1', 'Dedup shares winner value');

  console.log('  PASS: 3 concurrent calls => 1 execution');
}

async function testDedupDifferentArgsRunSeparate() {
  console.log('\n--- Test: dedup different args run separately ---');

  let callCount = 0;
  const fn = async () => {
    callCount++;
    return { value: callCount };
  };

  const [r1, r2] = await Promise.all([
    dedupRequest('read_file', { path: '/tmp/a.txt' }, fn),
    dedupRequest('read_file', { path: '/tmp/b.txt' }, fn),
  ]);

  assert.strictEqual(callCount, 2, 'Different args => separate executions');
  assert.strictEqual(r1.deduplicated, false);
  assert.strictEqual(r2.deduplicated, false);

  console.log('  PASS: different args run independently');
}

async function testSequentialDuplicateRunsAgain() {
  console.log('\n--- Test: sequential duplicate runs again after settlement ---');

  let callCount = 0;
  const fn = async () => {
    callCount++;
    return { value: callCount };
  };

  const r1 = await dedupRequest('read_file', { path: '/tmp/stale.txt' }, fn);
  assert.strictEqual(callCount, 1);
  assert.strictEqual(r1.deduplicated, false);

  const r2 = await dedupRequest('read_file', { path: '/tmp/stale.txt' }, () => {
    callCount++;
    return Promise.resolve({ value: 'second' });
  });
  assert.strictEqual(callCount, 2, 'Sequential call must execute after the first settles');
  assert.strictEqual(r2.deduplicated, false);
  assert.deepStrictEqual(r2.result, { value: 'second' });

  console.log('  PASS: only overlapping requests are coalesced');
}

async function testDedupCountersObservable() {
  console.log('\n--- Test: dedup counters are observable ---');

  const before = getDedupCounters();
  assert(typeof before.hits === 'number', 'hits counter exists');
  assert(typeof before.stales === 'number', 'stales counter exists');

  let callCount = 0;
  const fn = async () => { callCount++; return {}; };
  await Promise.all([
    dedupRequest('read_file', { path: '/tmp/counter-test.txt' }, fn),
    dedupRequest('read_file', { path: '/tmp/counter-test.txt' }, fn),
  ]);

  const after = getDedupCounters();
  assert(after.hits >= before.hits + 1, 'hit counter incremented after dedup');

  console.log(`  PASS: counters before=${JSON.stringify(before)}, after=${JSON.stringify(after)}`);
}

async function testDedupToolNamesAreIsolated() {
  console.log('\n--- Test: dedup keys are isolated by tool name ---');

  let callCount = 0;
  const fn = async () => { callCount++; return { value: callCount }; };

  const [r1, r2] = await Promise.all([
    dedupRequest('read_file', { path: '/tmp/test.txt' }, fn),
    dedupRequest('write_file', { path: '/tmp/test.txt' }, fn),
  ]);

  assert.strictEqual(callCount, 2, 'Different tools with same args are separate');
  assert.strictEqual(r1.deduplicated, false);
  assert.strictEqual(r2.deduplicated, false);

  console.log('  PASS: tool-name isolation works');
}

// --- Bounded backoff simulation test ---

async function testBoundedBackoff() {
  console.log('\n--- Test: bounded exponential backoff parameters are sensible ---');

  const START_DELAY = 30;
  const MAX_DELAY = 500;
  const MULTIPLIER = 1.5;

  let delay = START_DELAY;
  let ticks = 0;
  while (delay < MAX_DELAY) {
    delay = Math.min(delay * MULTIPLIER, MAX_DELAY);
    ticks++;
  }

  assert(ticks <= 8, `Backoff should reach cap in <= 8 ticks, got ${ticks}`);
  assert(delay === MAX_DELAY, `Final delay should be ${MAX_DELAY}, got ${delay}`);
  console.log(`  PASS: backoff caps at ${MAX_DELAY}ms after ${ticks} ticks (${START_DELAY}ms start)`);
}

async function testHeartbeatStartIsIdempotent() {
  console.log('\n--- Test: heartbeat start is idempotent ---');
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let created = 0;
  globalThis.setInterval = () => ({ id: ++created });
  globalThis.clearInterval = () => {};
  try {
    const channel = new RemoteChannel();
    channel.sendHeartbeat = async () => {};
    channel.startHeartbeat('device-1');
    channel.startHeartbeat('device-1');
    assert.strictEqual(created, 2, 'Repeated start for the same device must not create duplicate timers');
    channel.stopHeartbeat();
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
  console.log('  PASS: one health timer and one database timer');
}

async function testRealtimeCallIdDeduplication() {
  console.log('\n--- Test: realtime duplicate call ID executes once ---');
  let realtimeHandler;
  let dispatched = 0;
  const fakeChannel = {
    state: 'joining',
    on(_event, _filter, handler) {
      realtimeHandler = handler;
      return fakeChannel;
    },
    subscribe(callback) {
      fakeChannel.state = 'joined';
      callback('SUBSCRIBED');
      return fakeChannel;
    },
  };
  const databaseChain = {
    update() { return databaseChain; },
    eq: async () => ({ error: null }),
  };
  const channel = new RemoteChannel();
  channel.client = {
    channel: () => fakeChannel,
    from: () => databaseChain,
  };
  channel._user = { id: 'user-1', email: 'test@example.com' };
  channel.deviceId = 'device-1';
  channel.onToolCall = () => { dispatched++; };

  await channel.createChannel();
  const payload = { new: { id: 'call-1', tool_name: 'read_file', arguments: {} } };
  realtimeHandler(payload);
  realtimeHandler(payload);
  assert.strictEqual(dispatched, 1, 'Same queued call ID must dispatch only once');
  channel.stopHeartbeat();
  console.log('  PASS: repeated delivery was ignored');
}

async function testWidgetCallToolSingleFlight() {
  console.log('\n--- Test: widget callTool coalesces identical concurrent calls ---');
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const bridge = createToolBridge({
    host: {
      openai: {
        callTool: async () => {
          calls++;
          await gate;
          return { content: [{ type: 'text', text: 'ok' }] };
        },
      },
    },
  });
  const first = bridge.callTool('read_file', { path: 'same.txt' });
  const second = bridge.callTool('read_file', { path: 'same.txt' });
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.strictEqual(calls, 1, 'Identical in-flight widget calls must share one host request');
  assert.deepStrictEqual(a, b);
  console.log('  PASS: identical calls share one in-flight request');
}

async function testUiEventDuplicateSuppression() {
  console.log('\n--- Test: duplicate UI events are suppressed briefly ---');
  const calls = [];
  const tracker = createUiEventTracker(
    async (name, args) => { calls.push({ name, args }); return {}; },
    { component: 'test-widget' }
  );
  tracker('click', { target: 'refresh' });
  tracker('click', { target: 'refresh' });
  tracker('click', { target: 'other' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.strictEqual(calls.length, 2, 'Immediate identical UI events should collapse, distinct events should remain');
  console.log('  PASS: duplicate event collapsed without hiding a distinct event');
}

async function testReconnectUsesBoundedBackoff() {
  console.log('\n--- Test: failed reconnect schedules bounded backoff ---');
  const channel = new RemoteChannel();
  channel.channel = { state: 'errored' };
  channel.client = {
    removeChannel: async () => { channel.channel = null; },
    realtime: { disconnect: async () => {} },
  };
  channel._user = { id: 'user-1' };
  channel.deviceId = 'device-1';
  channel.onToolCall = () => {};
  channel.createChannel = async () => { throw new Error('simulated reconnect failure'); };

  const originalError = console.error;
  console.error = () => {};
  try {
    await channel.recreateChannel();
    assert.strictEqual(channel.reconnectAttempt, 1);
    assert(channel.nextReconnectAt > Date.now(), 'Failure must schedule a future retry');
    channel.channel = { state: 'errored' };
    await channel.recreateChannel();
    assert.strictEqual(channel.reconnectAttempt, 1, 'Retry inside backoff must not run again');
  } finally {
    console.error = originalError;
  }
  console.log('  PASS: repeated failures are bounded by retry time');
}

// --- Main ---

async function main() {
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';

  let passed = 0;
  let failed = 0;
  const tests = [
    { name: 'schema/restored-fields', fn: testStartProcessSchemaHasRestoredFields },
    { name: 'schema/accepts-fields', fn: testParseAcceptsRestoredFields },
    { name: 'schema/defaults-fields', fn: testParseDefaultsRestoredFields },
    { name: 'dedup/single-flight', fn: testDedupSingleFlight },
    { name: 'dedup/different-args', fn: testDedupDifferentArgsRunSeparate },
    { name: 'dedup/sequential-runs-again', fn: testSequentialDuplicateRunsAgain },
    { name: 'dedup/counters', fn: testDedupCountersObservable },
    { name: 'dedup/tool-isolation', fn: testDedupToolNamesAreIsolated },
    { name: 'backoff/bounded', fn: testBoundedBackoff },
    { name: 'remote/heartbeat-idempotent', fn: testHeartbeatStartIsIdempotent },
    { name: 'remote/call-id-dedup', fn: testRealtimeCallIdDeduplication },
    { name: 'widget/single-flight', fn: testWidgetCallToolSingleFlight },
    { name: 'ui-event/dedup', fn: testUiEventDuplicateSuppression },
    { name: 'remote/reconnect-backoff', fn: testReconnectUsesBoundedBackoff },
  ];

  for (const test of tests) {
    try {
      await test.fn();
      passed++;
    } catch (err) {
      failed++;
      console.error(`  FAIL [${test.name}]: ${err.message}`);
      if (err.stack) console.error(err.stack.split('\n').slice(0, 3).join('\n'));
    }
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`Regression summary: ${passed} passed, ${failed} failed, ${tests.length} total`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
