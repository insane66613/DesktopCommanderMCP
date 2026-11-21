/** Numeric search arguments must be finite safe whole numbers. */
import assert from 'node:assert/strict';
import { StartSearchArgsSchema, GetMoreSearchResultsArgsSchema } from '../dist/tools/schemas.js';
import { runIfMain } from './helpers/run-if-main.js';

export default function runTests() {
  const query = { path: '.', pattern: 'needle' };
  assert.equal(StartSearchArgsSchema.safeParse(query).success, true);
  for (const [field, valid] of [['maxResults', 0], ['contextLines', 0], ['timeout_ms', 0]]) {
    assert.equal(StartSearchArgsSchema.safeParse({ ...query, [field]: valid }).success, true);
    for (const invalid of [-1, 0.5, 1.2, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(StartSearchArgsSchema.safeParse({ ...query, [field]: invalid }).success, false,
        `${field} must reject ${String(invalid)}`);
    }
  }
  assert.equal(GetMoreSearchResultsArgsSchema.safeParse({ sessionId: 's', offset: -5, length: 1 }).success, true);
  for (const key of ['offset', 'length']) {
    for (const invalid of [0.25, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      assert.equal(GetMoreSearchResultsArgsSchema.safeParse({
        sessionId: 's', [key]: invalid,
      }).success, false, `${key} must reject ${String(invalid)}`);
    }
  }
  assert.equal(GetMoreSearchResultsArgsSchema.safeParse({ sessionId: 's', length: 0 }).success, false);
  console.log('PASS whole-number and range bounds for search tools');
  return true;
}
runIfMain(import.meta.url, runTests);
