import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { searchFiles } from '../dist/tools/filesystem.js';

const testDir = path.dirname(fileURLToPath(import.meta.url));
const root = await fs.mkdtemp(path.join(testDir, '__search_files_probe_'));
try {
  const count = 265;
  await Promise.all(Array.from({ length: count }, async (_, index) => {
    const file = path.join(root, '__probe_search_' + String(index).padStart(4, '0') + '.txt');
    await fs.writeFile(file, 'fixture ' + index + '\n');
  }));
  const started = performance.now();
  const paths = await searchFiles(root, '__probe_search_');
  const elapsedMs = Number((performance.now() - started).toFixed(2));
  const filenames = paths.map(file => path.basename(file)).sort();
  const expected = Array.from({ length: count }, (_, index) =>
    '__probe_search_' + String(index).padStart(4, '0') + '.txt').sort();
  assert.deepEqual(filenames, expected, 'real file search must return every unique match exactly once');
  console.log(JSON.stringify({ result: 'PASS', files: paths.length, unique: new Set(paths).size, elapsedMs }));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
