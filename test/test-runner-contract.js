import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runIfMain } from './helpers/run-if-main.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(testDir);

function run(args) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

async function check() {
  const fixtures = ['false', 'throw', 'pass'].map((name) => path.join(testDir, 'repro', `dc-runner-${process.pid}-${name}.js`));
  try {
    for (const [index, body] of ['return false;', 'throw new Error("expected failure");', 'return true;'].entries()) {
      fs.writeFileSync(fixtures[index], `import { runIfMain } from '../helpers/run-if-main.js';\nrunIfMain(import.meta.url, () => { ${body} });\n`);
      assert.equal(run([fixtures[index]]).code, index === 2 ? 0 : 1, 'direct test must propagate its outcome');
      const repro = run(['test/repro/run-repro.js', path.relative(root, fixtures[index])]);
      assert.equal(repro.code, index === 2 ? 0 : 1, 'repro runner must propagate its outcome');
      assert(repro.output.includes(path.basename(fixtures[index])), 'path selection must run the named repro');
    }
    const selected = run(['test/run-all-tests.js', 'test/test-temp-dir.js']);
    assert.equal(selected.code, 0, selected.output);
    assert.equal((selected.output.match(/Running test module:/g) ?? []).length, 1, 'selection must run only one module');
    assert(selected.output.includes('test-temp-dir.js'), 'selection must run the requested module');
    console.log('✓ direct failures, repro path selection/exit codes, and single-module selection');
  } finally {
    for (const file of fixtures) fs.rmSync(file, { force: true });
  }
}

runIfMain(import.meta.url, check);
