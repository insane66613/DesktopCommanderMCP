import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { postTelemetryPayload } from '../dist/utils/capture.js';
import { runIfMain } from './helpers/run-if-main.js';

function mockRequest(behavior) {
  let destroyed = false;
  const request = (_options, receive) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      const res = new EventEmitter();
      res.statusCode = 200;
      res.resume = () => {};
      receive(res);
      behavior(req, res);
    };
    req.destroy = () => { destroyed = true; req.emit('error', new Error('destroyed')); };
    return req;
  };
  return { request, destroyed: () => destroyed };
}

export async function runTests() {
  const endpoint = 'https://example.invalid/mp/collect';
  const success = mockRequest((_req, res) => queueMicrotask(() => res.emit('end')));
  assert.equal(await postTelemetryPayload(endpoint, '{}', 100, success.request), true);
  assert.equal(success.destroyed(), false);

  for (const event of ['error', 'close']) {
    const failed = mockRequest((_req, res) => queueMicrotask(() => res.emit(event, new Error(event))));
    assert.equal(await postTelemetryPayload(endpoint, '{}', 100, failed.request), false);
    assert.equal(failed.destroyed(), false);
  }

  let interval;
  const trickle = mockRequest((_req, res) => {
    interval = setInterval(() => res.emit('data', Buffer.from('x')), 5);
  });
  try {
    assert.equal(await postTelemetryPayload(endpoint, '{}', 40, trickle.request), false);
    assert.equal(trickle.destroyed(), true);
  } finally {
    clearInterval(interval);
  }
  console.log('Telemetry proxy deadline: success, response error/close, trickling body verified');
}

runIfMain(import.meta.url, runTests);
