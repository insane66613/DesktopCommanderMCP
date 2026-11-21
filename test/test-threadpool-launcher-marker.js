#!/usr/bin/env node
/** Copilot review regression: reject malformed/foreign launcher PID markers. */
import assert from 'node:assert/strict';
import { validateLauncherPidMarker } from '../dist/utils/threadpool-size.js';

const parent = 1234;
for (const bad of [undefined, '', 'abc', '0', '-5', '12.5', '12abc',
                   '001234', '90071992547409930', '1235', ' 1234 ', '+1234']) {
  assert.equal(validateLauncherPidMarker(bad, parent), null,
    `invalid or unrelated launcher marker: ${String(bad)}`);
}
assert.equal(validateLauncherPidMarker('1234', parent), parent);
assert.equal(validateLauncherPidMarker(String(process.ppid)), process.ppid);
assert.equal(validateLauncherPidMarker(String(process.pid)), null,
  'current process must never be mistaken for its parent');
console.log('PASS launcher PID markers require positive exact parent identity');
