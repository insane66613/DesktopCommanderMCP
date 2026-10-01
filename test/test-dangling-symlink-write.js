import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runIfMain } from './helpers/run-if-main.js';
import { createTestEnv } from './helpers/test-env.js';

async function runTests() {
  const testEnv = createTestEnv('dc-dangling-write-');
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  Object.assign(process.env, testEnv.env);
  const { configManager } = await import('../dist/config-manager.js');
  const { validatePath, writeFile } = await import('../dist/tools/filesystem.js');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-dangling-paths-'));
  const allowed = path.join(root, 'allowed');
  const outside = path.join(root, 'outside');
  await fs.mkdir(allowed);
  await fs.mkdir(outside);
  try {
    await configManager.setValue('allowedDirectories', [allowed]);
    const escapedTarget = path.join(outside, 'missing');
    const safeTarget = path.join(allowed, 'missing');
    const escapedLink = path.join(allowed, 'escape');
    const safeLink = path.join(allowed, 'safe');
    await fs.symlink(escapedTarget, escapedLink, 'junction');
    await fs.symlink(safeTarget, safeLink, 'junction');
    await assert.rejects(validatePath(path.join(escapedLink, 'new.txt')), /Path not allowed/);
    await assert.rejects(writeFile(path.join(escapedLink, 'new.txt'), 'secret'), /Path not allowed/);
    await assert.rejects(fs.stat(escapedTarget), { code: 'ENOENT' });
    assert.equal(await validatePath(path.join(safeLink, 'new.txt')), path.join(safeTarget, 'new.txt'));
    await fs.mkdir(safeTarget);
    await writeFile(path.join(safeLink, 'new.txt'), 'allowed');
    assert.equal(await fs.readFile(path.join(safeTarget, 'new.txt'), 'utf8'), 'allowed');
    // A link chain must resolve its final target, including missing descendants.
    const chain = path.join(allowed, 'chain');
    await fs.symlink(escapedLink, chain, 'junction');
    await assert.rejects(validatePath(path.join(chain, 'deep', 'new.txt')), /Path not allowed/);
    console.log('Dangling junction writes stay inside allowed directories; safe links and chained escapes checked.');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
    testEnv.cleanup();
  }
}

runIfMain(import.meta.url, runTests);
