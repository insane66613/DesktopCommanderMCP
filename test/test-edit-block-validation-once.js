import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--isolated-child') {
  const env = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [ownPath, '--isolated-child'], {
      env: env.env, encoding: 'utf8', timeout: 60_000
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, 'edit validation single-pass regression failed');
  } finally {
    env.cleanup();
  }
} else {
  process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
  const distRoot = process.env.DC_TEST_DIST_ROOT ??
    fileURLToPath(new URL('../dist/', import.meta.url));
  const load = (name) => import(pathToFileURL(path.join(distRoot, name)).href);
  const { configManager } = await load('config-manager.js');
  const { performSearchReplace } = await load('tools/edit.js');
  await configManager.setValue('allowedDirectories', [os.homedir()]);
  const file = path.join(os.homedir(), 'edit-validation-once-fixture.txt');
  await fs.writeFile(file, 'before\r\nafter\r\n', 'utf8');
  const original = fs.stat;
  let targetCalls = 0;
  try {
    fs.stat = async (...args) => {
      if (path.resolve(String(args[0])) === file) targetCalls++;
      return original(...args);
    };
    const result = await performSearchReplace(file, {
      search: 'before', replace: 'updated'
    }, 1);
    assert.ok(!result.isError, 'edit_block returned an error');
    assert.match(result.content?.[0]?.text ?? '', /updated/);
    const final = await fs.readFile(file, 'utf8');
    assert.equal(final, 'updated\r\nafter\r\n',
      'edit must preserve original CRLF line endings');
    console.log('Target fs.promises.stat calls in edit_block:', targetCalls);
    assert.equal(targetCalls, 2,
      'performSearchReplace must rely on read-time and write-time checks, not repeat the initial validation');
  } finally {
    fs.stat = original;
    await fs.rm(file, { force: true });
  }
  console.log('PASS edit_block preserved line endings with read and write validation');
}
