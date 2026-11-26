import assert from 'node:assert/strict';
import { test } from 'node:test';
import { launchCaffeinateNonBlocking } from '../dist/utils/no-sleep.js';

test('caffeinate startup is nonblocking and uses the correct PID', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  let receivedPid;
  const errors = [];
  const started = launchCaffeinateNonBlocking(({ pid }) => {
    receivedPid = pid;
    return pending;
  }, 12345, error => errors.push(error));
  assert.equal(started, true);
  assert.equal(receivedPid, 12345);
  assert.deepEqual(errors, []);
  finish(0);
  await pending;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(errors, []);
});

test('asynchronous caffeinate rejection is observed', async () => {
  const error = new Error('sleep inhibitor failed later');
  const observed = [];
  assert.equal(launchCaffeinateNonBlocking(
    () => Promise.reject(error), 42, failure => observed.push(failure)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, [error]);
});

test('synchronous caffeinate failure is reported without claiming startup', () => {
  const error = new Error('unavailable');
  const observed = [];
  assert.equal(launchCaffeinateNonBlocking(() => { throw error; },
    99, failure => observed.push(failure)), false);
  assert.deepEqual(observed, [error]);
});

test('resolved caffeinate promise does not report failure', async () => {
  const observed = [];
  assert.equal(launchCaffeinateNonBlocking(() => Promise.resolve(1),
    91, failure => observed.push(failure)), true);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(observed, []);
});
