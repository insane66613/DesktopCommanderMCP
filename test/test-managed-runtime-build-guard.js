/** Installed-runtime builds must fail closed without touching production dist. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const guardName = 'assert-build-isolated.mjs';
const markerName = '.desktopcommander-managed-runtime-protected';
const runGuard = source => spawnSync(process.execPath, [source], {
  encoding: 'utf8', timeout: 5000, windowsHide: true,
});
export default async function runTests() {
  const fixture = await fsp.mkdtemp(path.join(os.tmpdir(), 'dc-build-guard-'));
  try {
    const scripts = path.join(fixture, 'scripts');
    await fsp.mkdir(scripts);
    const source = path.join(scripts, guardName);
    await fsp.copyFile(path.join(root, 'scripts', guardName), source);
    const unprotected = runGuard(source);
    assert.equal(unprotected.status, 0, unprotected.stderr);
    assert.equal(fs.existsSync(path.join(fixture, 'dist')), false);
    const marker = path.join(fixture, markerName);
    await fsp.writeFile(marker, 'managed production runtime: builds forbidden\n');
    const protectedRun = runGuard(source);
    assert.equal(protectedRun.status, 78, protectedRun.stderr);
    assert.match(protectedRun.stderr, /REFUSED.*installed managed runtime/s);
    await fsp.rm(marker);
    assert.equal(runGuard(source).status, 0);
    const pkg = JSON.parse(await fsp.readFile(path.join(root, 'package.json'), 'utf8'));
    for (const name of ['build', 'clean', 'watch', 'setup', 'setup:debug',
      'release', 'release:minor', 'release:major', 'release:dry',
      'release:rehearsal', 'release:alpha']) {
      assert(pkg.scripts[name]?.startsWith('node scripts/assert-build-isolated.mjs &&'),
        `Missing non-bypassable guard prefix on npm script: ${name}`);
    }
    console.log('PASS protected marker denies build scripts without dist mutation');
  } finally {
    await fsp.rm(fixture, { recursive: true, force: true });
  }
}
runIfMain(import.meta.url, runTests);
