import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--isolated-child') {
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [ownPath, '--isolated-child'], {
      env: isolated.env, encoding: 'utf8', timeout: 60_000
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, 'single-stat read_file regression failed');
  } finally {
    isolated.cleanup();
  }
} else {
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  const distRoot = process.env.DC_TEST_DIST_ROOT ??
    fileURLToPath(new URL('../dist/', import.meta.url));
  const load = (name) => import(pathToFileURL(path.join(distRoot, name)).href);
  const { configManager } = await load('config-manager.js');
  const { readFileFromDisk } = await load('tools/filesystem.js');
  const file = path.join(os.homedir(), 'stat-reuse-fixture.txt');
  await configManager.setValue('allowedDirectories', [os.homedir()]);
  await fs.writeFile(file, 'first\nsecond\nthird', 'utf8');
  const original = fs.stat;
  let calls = 0;
  try {
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === file) calls++;
      return original(...args);
    };
    const result = await readFileFromDisk(file, { offset: 0, length: 2 });
    assert.equal(result.metadata?.isBinary, undefined);
    assert.match(result.content, /first/);
    assert.match(result.content, /second/);
    assert.doesNotMatch(result.content, /third/);
    console.log('Target fs.promises.stat calls in read_file:', calls);
    assert.equal(calls, 4,
      'a regular read_file should reuse directory stat for file-size telemetry');

    // If the directory probe fails transiently, still retry stat for telemetry
    // and then read normally. No negative caching or swallowed I/O failures.
    calls = 0;
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === file) {
        calls++;
        if (calls === 2) {
          const error = Object.assign(new Error('one-shot stat failure'), { code: 'EIO' });
          throw error;
        }
      }
      return original(...args);
    };
    const retried = await readFileFromDisk(file, { offset: 0, length: 2 });
    assert.match(retried.content, /first/);
    assert.match(retried.content, /second/);
    assert.equal(calls, 5, 'failed initial file probe must trigger one retry');
  } finally {
    fs.stat = original;
    await fs.rm(file, { force: true });
  }
  console.log('PASS read_file reuses file stat without altering content and pagination');
}
