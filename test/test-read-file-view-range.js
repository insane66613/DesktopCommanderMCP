/**
 * Editor-style one-based read_file range compatibility and input hardening.
 * Run in a separate HOME even when invoked outside the test-suite runner.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';

const self = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--isolated-child') {
  const sandbox = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [self, '--isolated-child'], {
      encoding: 'utf8', timeout: 90_000, env: sandbox.env,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, 'isolated view_range regression failed');
  } finally { sandbox.cleanup(); }
} else {
  const dist = process.env.DC_TEST_DIST_ROOT ?? fileURLToPath(new URL('../dist/', import.meta.url));
  const load = p => import(pathToFileURL(path.join(dist, p)).href);
  const { ReadFileArgsSchema } = await load('tools/schemas.js');
  const { configManager } = await load('config-manager.js');
  const { handleReadFile } = await load('handlers/filesystem-handlers.js');
  const fixture = path.join(os.homedir(), 'dc-view-range-sample.txt');
  await fs.writeFile(fixture, ['vrline01', 'vrline02', 'vrline03', 'vrline04', 'vrline05'].join('\n'));
  try {
    await configManager.setValue('allowedDirectories', [os.homedir()]);
    await configManager.setValue('fileReadLineLimit', 2);
    const text = async args => {
      const result = await handleReadFile({ path: fixture, ...args });
      assert.ok(!result.isError, JSON.stringify(result.content));
      return result.content.map(entry => entry.text ?? '').join('\n');
    };
    const span = await text({ view_range: [2, 3] });
    assert.match(span, /vrline02/);
    assert.match(span, /vrline03/);
    assert.doesNotMatch(span, /vrline01|vrline04/);
    const single = await text({ view_range: [1, 1] });
    assert.match(single, /vrline01/);
    assert.doesNotMatch(single, /vrline02/);
    const throughDefault = await text({ view_range: [3, -1] });
    assert.match(throughDefault, /vrline03/);
    assert.match(throughDefault, /vrline04/);
    assert.doesNotMatch(throughDefault, /vrline05/);
    // CRLF and multibyte characters must retain their original line boundaries.
    const unicodeFile = path.join(os.homedir(), 'dc-view-range-unicode.txt');
    await fs.writeFile(unicodeFile, 'start😀\r\nsecond雪\r\nthird🍉');
    try {
      const unicode = await handleReadFile({ path: unicodeFile, view_range: [2, 2] });
      assert.ok(!unicode.isError, JSON.stringify(unicode.content));
      const contents = unicode.content.map(entry => entry.text ?? '').join('\n');
      assert.match(contents, /second雪/);
      assert.doesNotMatch(contents, /start😀|third🍉/);
    } finally { await fs.rm(unicodeFile, { force: true }); }
    const legacy = await text({ offset: 1, length: 2 });
    assert.match(legacy, /vrline02/);
    assert.match(legacy, /vrline03/);
    for (const key of ['offset', 'length']) {
      for (const value of [0, undefined]) {
        // Property presence is the contract, including explicitly undefined.
        const collision = await handleReadFile({ path: fixture, view_range: [2, 3], [key]: value });
        assert.equal(collision.isError, true, `collision with ${key} was accepted`);
        assert.match(JSON.stringify(collision.content), /cannot be combined/);
      }
    }
    assert.equal(ReadFileArgsSchema.safeParse({ path: fixture, view_range: null }).success, false);
    assert.equal(ReadFileArgsSchema.safeParse({ path: fixture, view_range: [2, 3], offset: null }).success, false);
    const max = Number.MAX_SAFE_INTEGER;
    assert.equal(ReadFileArgsSchema.safeParse({ path: fixture, view_range: [max, max] }).success, true);
    for (const range of [[0, 2], [-1, 1], [3, 2], [1, 0], [1, -2],
      [1, 1.5], [1, 2, 3], [1], ['1', 2], [1, Number.MAX_SAFE_INTEGER + 1]]) {
      assert.equal(ReadFileArgsSchema.safeParse({ path: fixture, view_range: range }).success,
        false, `invalid range accepted: ${JSON.stringify(range)}`);
    }
    assert.deepEqual(ReadFileArgsSchema.parse({ path: fixture, view_range: [2, 3] }).view_range, [2, 3]);
    console.log('PASS: validated one-based inclusive view_range, capped -1, and legacy offset compatibility');
  } finally {
    await fs.rm(fixture, { force: true });
  }
}
