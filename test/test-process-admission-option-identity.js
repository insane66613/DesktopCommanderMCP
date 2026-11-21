/**
 * A short dedupe window must not collapse process requests with distinct
 * security/window controls. Rate limiting still applies to all launches.
 */
import assert from 'node:assert/strict';
import { processLaunchAdmission } from '../dist/tools/improved-process-tools.js';
import { runIfMain } from './helpers/run-if-main.js';

export default async function runTests() {
  const base = {
    command: 'echo option-identity-fixture',
    shell: 'pwsh.exe',
    origin: 'llm',
    visible: false,
    exclude_self: false,
    keep_open: false,
  };
  assert.equal(processLaunchAdmission(base).allowed, true, 'first launch admitted');
  assert.equal(
    processLaunchAdmission({ ...base, exclude_self: true }).allowed,
    true,
    'exclude_self changes process termination/visibility safety and must not be deduplicated',
  );
  assert.equal(
    processLaunchAdmission({ ...base, keep_open: true }).allowed,
    false,
    'unimplemented keep_open hint must not bypass process deduplication',
  );
  assert.equal(
    processLaunchAdmission({ ...base, window_title: 'Distinct diagnostic window' }).allowed,
    false,
    'unimplemented window_title hint must not bypass process deduplication',
  );
  const duplicate = processLaunchAdmission(base);
  assert.equal(duplicate.allowed, false, 'truly identical retry must still be blocked');
  assert.equal(duplicate.reason, 'identical launch suppressed');
  assert(duplicate.retryAfterMs > 0 && duplicate.retryAfterMs <= 3000);
  console.log('PASS effective safety options stay independent, unsupported hints cannot bypass deduplication');
}

runIfMain(import.meta.url, runTests);
