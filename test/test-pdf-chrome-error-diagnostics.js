/** Validate browser errors without downloading Chrome or starting a renderer. */
import assert from 'node:assert/strict';
import { explainChromeLaunchFailure } from '../dist/tools/pdf/markdown.js';
const missing = new Error('Could not find Chrome (ver. 143.0.7499.169)');
const launchFailed = new Error('Failed to launch the browser process!');
const missingAfterDownload = explainChromeLaunchFailure(missing, true);
assert.match(missingAfterDownload.message, /automatic Chrome download failed/);
assert.match(missingAfterDownload.message, /server logs/);
const launchAfterDownload = explainChromeLaunchFailure(launchFailed, true);
assert.match(launchAfterDownload.message, /automatic Chrome download failed/);
assert.equal(explainChromeLaunchFailure(launchFailed, false), undefined,
  'preserve unrelated launch errors without failed download');
assert.match(explainChromeLaunchFailure(missing, false).message,
  /requires Chrome or Chromium browser/);
assert.equal(explainChromeLaunchFailure(new Error('Invalid PDF stylesheet'), true), undefined,
  'do not misclassify unrelated PDF failures');
const privateError = explainChromeLaunchFailure(
  new Error('Could not find Chrome: Authorization=private-secret'), true);
assert.doesNotMatch(privateError.message, /private-secret/,
  'raw server errors must not leak into tool responses');
console.log('PASS: download-failed guidance, missing Chrome, launch errors, unrelated errors and private-error filtering');