import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createTestEnv } from './helpers/test-env.js';

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[2] !== '--isolated-child') {
  // The runner must never touch the real Desktop Commander configuration,
  // even when somebody invokes this test directly outside npm test.
  const isolated = createTestEnv();
  try {
    const child = spawnSync(process.execPath, [ownPath, '--isolated-child'], {
      encoding: 'utf8',
      timeout: 90_000,
      env: isolated.env,
    });
    if (child.stdout) process.stdout.write(child.stdout);
    if (child.stderr) process.stderr.write(child.stderr);
    assert.equal(child.status, 0, 'isolated read_file limit regression failed');
  } finally {
    isolated.cleanup();
  }
} else {
  const distRoot = process.env.DC_TEST_DIST_ROOT ??
    fileURLToPath(new URL('../dist/', import.meta.url));
  const load = (p) => import(pathToFileURL(path.join(distRoot, p)).href);
  const { ReadFileArgsSchema } = await load('tools/schemas.js');
  const { configManager } = await load('config-manager.js');
  const { handleReadFile } = await load('handlers/filesystem-handlers.js');

  const home = os.homedir();
  const fixture = path.join(home, 'dc-read-limit-sample.txt');
  await fs.writeFile(fixture, 'one\ntwo\nthree\nfour\nfive', 'utf8');
  try {
    const omitted = ReadFileArgsSchema.parse({ path: fixture });
    assert.equal(omitted.length, undefined,
      'omitted length must remain undefined so runtime configuration applies');
    const explicit = ReadFileArgsSchema.parse({ path: fixture, length: 4 });
    assert.equal(explicit.length, 4, 'explicit caller length must be preserved');
    await configManager.setValue('allowedDirectories', [home]);
    await configManager.setValue('fileReadLineLimit', 2);
    const config = await configManager.getConfig();
    assert.equal(config.fileReadLineLimit, 2);

    function fileText(result) {
      assert.ok(!result?.isError, JSON.stringify(result?.content));
      const text = result?.content?.map(item => item.text ?? '').join('\n') ?? '';
      assert.ok(text.includes('one') || text.includes('two'),
        'read_file produced no fixture contents');
      return text;
    }
    const omittedText = fileText(await handleReadFile({ path: fixture }));
    assert.match(omittedText, /one/);
    assert.match(omittedText, /two/);
    assert.doesNotMatch(omittedText, /three/, 'configured 2-line limit ignored');

    const explicitText = fileText(
      await handleReadFile({ path: fixture, length: 4 }));
    assert.match(explicitText, /four/);
    assert.doesNotMatch(explicitText, /five/, 'explicit 4-line limit ignored');

    const offsetText = fileText(await handleReadFile({ path: fixture, offset: 1 }));
    assert.match(offsetText, /two/);
    assert.match(offsetText, /three/);
    assert.doesNotMatch(offsetText, /four/,
      'configured default not respected with nonzero offset');

    console.log('PASS: read_file omitted length follows fileReadLineLimit=2');
    console.log('PASS: explicit length=4 takes precedence');
    console.log('PASS: nonzero offsets still honor configured default');
    console.log('PASS: direct execution is isolated from real config');
  } finally {
    await fs.rm(fixture, { force: true });
  }
}
