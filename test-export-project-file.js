import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleExportProjectFile, handleReceiveFile } from './dist/handlers/filesystem-handlers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function test() {
  // Create test files
  const testDir = path.join(__dirname, 'test-export-project');
  await fs.mkdir(testDir, { recursive: true });

  // Test 1: Export a small UTF-8 source file
  const testFile = path.join(testDir, 'test-source.ts');
  await fs.writeFile(testFile, 'export const hello = "world";\nconsole.log(hello);\n');

  console.log('=== Test 1: Export small UTF-8 source file ===');
  const result1 = await handleExportProjectFile({ path: testFile });
  console.log(result1.content[0].text);
  console.log('structuredContent:', JSON.stringify(result1.structuredContent, null, 2));
  assert.equal(result1.structuredContent.content, 'export const hello = "world";\nconsole.log(hello);\n');

  // Test 2: Export with encoding=base64
  console.log('\n=== Test 2: Export with encoding=base64 ===');
  const result2 = await handleExportProjectFile({ path: testFile, encoding: 'base64' });
  console.log(result2.content[0].text);
  console.log('encoding:', result2.structuredContent.encoding);
  assert.equal(result2.structuredContent.encoding, 'base64');

  // Test 3: Export with maxBytes=20 and confirm truncated=true
  console.log('\n=== Test 3: Export with maxBytes=20 (truncated) ===');
  const result3 = await handleExportProjectFile({ path: testFile, maxBytes: 20 });
  console.log(result3.content[0].text);
  console.log('truncated:', result3.structuredContent.truncated);
  console.log('returnedBytes:', result3.structuredContent.returnedBytes);
  console.log('byteCount:', result3.structuredContent.byteCount);
  assert.equal(result3.structuredContent.truncated, true);
  assert.equal(result3.structuredContent.returnedBytes, 20);

  // Test 4: Export with offset=20 and confirm paging works
  console.log('\n=== Test 4: Export with offset=20 (paging) ===');
  const result4 = await handleExportProjectFile({ path: testFile, offset: 20 });
  console.log(result4.content[0].text);
  console.log('offset:', result4.structuredContent.offset);
  assert.equal(result4.structuredContent.offset, 20);

  // Test 5: Export a directory and confirm it is rejected
  console.log('\n=== Test 5: Export directory (should be rejected) ===');
  const result5 = await handleExportProjectFile({ path: testDir });
  console.log(result5.content[0].text);
  assert.equal(result5.isError, true);

  // Test 6: Export .env and confirm it is rejected by default
  console.log('\n=== Test 6: Export .env (should be rejected by default) ===');
  const envFile = path.join(testDir, '.env');
  await fs.writeFile(envFile, 'SECRET=value\n');
  const result6 = await handleExportProjectFile({ path: envFile });
  console.log(result6.content[0].text);
  assert.equal(result6.isError, true);

  // Test 7: Export .env.example and confirm it is allowed
  console.log('\n=== Test 7: Export .env.example (should be allowed) ===');
  const envExampleFile = path.join(testDir, '.env.example');
  await fs.writeFile(envExampleFile, 'EXAMPLE=value\n');
  const result7 = await handleExportProjectFile({ path: envExampleFile });
  console.log(result7.content[0].text);
  assert.equal(result7.isError, undefined);

  // Test 8: Export .env with allowSensitiveProjectFile=true and confirm it works
  console.log('\n=== Test 8: Export .env with allowSensitiveProjectFile=true ===');
  const result8 = await handleExportProjectFile({ path: envFile, allowSensitiveProjectFile: true });
  console.log(result8.content[0].text);
  assert.equal(result8.isError, undefined);

  // Test 9: Receive requires an explicit mode before replacing existing content
  console.log('\n=== Test 9: Receive file overwrite guard ===');
  const receivedFile = path.join(testDir, 'received.txt');
  await fs.writeFile(receivedFile, 'existing\n');
  const encoded = Buffer.from('replacement\n').toString('base64');
  const blockedReceive = await handleReceiveFile({ path: receivedFile, content: encoded });
  assert.equal(blockedReceive.isError, true);
  const writtenReceive = await handleReceiveFile({ path: receivedFile, content: encoded, mode: 'rewrite' });
  assert.equal(writtenReceive.isError, undefined);
  assert.equal(await fs.readFile(receivedFile, 'utf8'), 'replacement\n');

  // Cleanup
  await fs.rm(testDir, { recursive: true, force: true });
}

test().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
