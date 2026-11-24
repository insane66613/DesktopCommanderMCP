import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { postTelemetryPayload } from '../dist/utils/capture.js';
import { runIfMain } from './helpers/run-if-main.js';

function mockRequest(behavior, { statusCode = 200, complete = true, requestError = false } = {}) {
  let destroyed = false;
  const request = (_options, receive) => {
    const req = new EventEmitter();
    req.write = () => {};
    req.end = () => {
      if (requestError) {
        queueMicrotask(() => req.emit('error', new Error('request error')));
        return;
      }
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.complete = complete;
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
  const success = mockRequest((_req, res) => queueMicrotask(() => {
    res.emit('end');
    res.emit('close');
  }));
  assert.equal(await postTelemetryPayload(endpoint, '{}', 100, success.request), true);
  assert.equal(success.destroyed(), false);

  for (const event of ['error', 'close', 'aborted']) {
    const failed = mockRequest((_req, res) => queueMicrotask(() => res.emit(event, new Error(event))));
    assert.equal(await postTelemetryPayload(endpoint, '{}', 100, failed.request), false);
    assert.equal(failed.destroyed(), false);
  }

  const incomplete = mockRequest((_req, res) => queueMicrotask(() => res.emit('end')), { complete: false });
  assert.equal(await postTelemetryPayload(endpoint, '{}', 100, incomplete.request), false);

  const rejected = mockRequest((_req, res) => queueMicrotask(() => res.emit('end')), { statusCode: 503 });
  assert.equal(await postTelemetryPayload(endpoint, '{}', 100, rejected.request), false);

  const requestError = mockRequest(() => {}, { requestError: true });
  assert.equal(await postTelemetryPayload(endpoint, '{}', 100, requestError.request), false);
  assert.equal(requestError.destroyed(), false);

  let interval;
  const trickle = mockRequest((_req, res) => {
    interval = setInterval(() => res.emit('data', Buffer.from('x')), 5);
  }, { complete: false });
  try {
    assert.equal(await postTelemetryPayload(endpoint, '{}', 40, trickle.request), false);
    assert.equal(trickle.destroyed(), true);
  } finally {
    clearInterval(interval);
  }
  console.log('Telemetry proxy deadline: complete success, non-2xx, request/response errors, aborted/incomplete close, and trickling body verified');
}

runIfMain(import.meta.url, runTests);
