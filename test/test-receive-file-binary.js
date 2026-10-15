import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { decodeReceivedContent } from '../dist/handlers/filesystem-handlers.js';

// PDF headers, audio bytes, and invalid UTF-8 must survive a transfer.
const original = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff, 0xfe, 0x80, 0x0a]);
const encoded = original.toString('base64');
const actual = decodeReceivedContent(encoded, 'base64');
assert.deepEqual(actual, original, 'Base64 must preserve the exact binary bytes');
assert.equal(createHash('sha256').update(actual).digest('hex'),
  createHash('sha256').update(original).digest('hex'));
assert.deepEqual(decodeReceivedContent('hello\nworld', 'utf8'),
  Buffer.from('hello\nworld', 'utf8'));
for (const malformed of ['%%%','a=bc','YWJj!','YWJj=','Y Q==','_abc']) {
  assert.throws(() => decodeReceivedContent(malformed, 'base64'), /Invalid base64/);
}
console.log('Binary-safe receive_file decode regression passed');
