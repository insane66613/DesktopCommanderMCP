/**
 * Tests for UI event tracking plumbing between apps and host interfaces. It verifies expected event envelopes so telemetry and diagnostics remain stable.
 */
import assert from 'assert';

import { server } from '../dist/server.js';
import { buildTrackUiEventCapturePayload } from '../dist/handlers/history-handlers.js';
import { createUiEventTracker } from '../dist/ui/shared/ui-event-tracker.js';
import { runIfMain } from './helpers/run-if-main.js';

function getRequestHandler(method) {
  const handlers = server._requestHandlers;
  assert.ok(handlers, 'Server request handlers should be initialized');
  const handler = handlers.get(method);
  assert.ok(handler, `Expected request handler for ${method}`);
  return handler;
}

async function testTrackUiEventCall() {
  console.log('\n--- Test: track_ui_event call ---');
  const callToolHandler = getRequestHandler('tools/call');
  const response = await callToolHandler({
    method: 'tools/call',
    params: {
      name: 'track_ui_event',
      arguments: {
        event: 'widget_expanded',
        component: 'file_preview',
        params: {
          file_type: 'markdown',
          line_count: 36,
          expanded: true
        }
      }
    }
  }, {});

  assert.ok(response, 'tools/call should return a response');
  assert.ok(Array.isArray(response.content), 'track_ui_event should return content array');
  assert.strictEqual(response.isError, undefined, 'track_ui_event should not return isError');
  assert.ok(response.content[0].text.includes('Tracked UI event'), 'track_ui_event should acknowledge event tracking');
  console.log('✓ track_ui_event call works');
}

async function testTrackUiEventPayloadCollisionProtection() {
  console.log('\n--- Test: track_ui_event payload collision protection ---');
  const payload = buildTrackUiEventCapturePayload('widget_expanded', 'file_preview', {
    event: 'spoofed',
    component: 'spoofed_component',
    line_count: 12
  });

  assert.strictEqual(payload.event, 'widget_expanded', 'Canonical event should override params.event');
  assert.strictEqual(payload.component, 'file_preview', 'Canonical component should override params.component');
  assert.strictEqual(payload.line_count, 12, 'Custom params should be preserved');
  console.log('✓ track_ui_event payload collision protection works');
}

async function testBoundedUiEventCache() {
  const realNow = Date.now;
  Date.now = () => 1000;
  try {
    const calls = [];
    const track = createUiEventTracker(async (_name, args) => {
      calls.push(args);
      return {};
    }, { component: 'test-widget' });
    for (let index = 0; index < 101; index++) track('click', { index });
    track('click', { index: 0 });
    assert.equal(calls.length, 102, 'cache must evict the oldest key when over 100');
  } finally {
    Date.now = realNow;
  }
  console.log('✓ bounded UI event cache retains a 100-key ceiling');
}

async function testRefreshedUiEventRetainsRecency() {
  const realNow = Date.now;
  let now = 1000;
  let calls = 0;
  Date.now = () => now;
  try {
    const track = createUiEventTracker(async () => {
      calls++;
      return {};
    }, { component: 'test-widget' });
    track('click', { index: 0 });
    now = 1100;
    for (let index = 1; index < 100; index++) track('click', { index });
    now = 1251;
    track('click', { index: 0 }); // expired and reaccepted: now newest
    track('click', { index: 100 }); // evicts an older entry, not 0
    const before = calls;
    track('click', { index: 0 }); // must remain suppressed for 250 ms
    assert.equal(calls, before, 'refreshed key evicted despite still being recent');
  } finally {
    Date.now = realNow;
  }
  console.log('✓ refreshed UI event retains eviction recency');
}

export default async function runTests() {
  try {
    await testTrackUiEventCall();
    await testTrackUiEventPayloadCollisionProtection();
    await testBoundedUiEventCache();
    await testRefreshedUiEventRetainsRecency();
    console.log('\n✅ UI event tracking tests passed!');
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('❌ Test failed:', message);
    if (error instanceof Error && error.stack) {
      console.error(error.stack);
    }
    return false;
  }
}

runIfMain(import.meta.url, runTests);
