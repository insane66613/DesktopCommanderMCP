import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { handleListDirectory } from '../dist/handlers/filesystem-handlers.js';
import { ListDirectoryArgsSchema } from '../dist/tools/schemas.js';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

async function result(root, includeHidden) {
  const args = {path: root, depth: 2};
  if (includeHidden !== undefined) args.includeHidden = includeHidden;
  const reply = await handleListDirectory(args);
  assert.notEqual(reply.isError, true, JSON.stringify(reply));
  return reply.content[0].text.split('\n');
}

async function runTests() {
  const root = createTempDir('dc-list-hidden-');
  try {
    fs.writeFileSync(path.join(root, '.secret'), 'hide only on opt-in');
    fs.writeFileSync(path.join(root, 'visible.txt'), 'always visible');
    fs.mkdirSync(path.join(root, '.private'));
    fs.writeFileSync(path.join(root, '.private', 'inside.txt'), 'nested hidden dir');
    fs.mkdirSync(path.join(root, 'public'));
    fs.writeFileSync(path.join(root, 'public', '.inner'), 'nested dotfile');
    fs.writeFileSync(path.join(root, 'public', 'normal.txt'), 'visible nested');
    assert.equal(ListDirectoryArgsSchema.parse({path: root}).includeHidden, true);
    assert.equal(ListDirectoryArgsSchema.parse({path: root, includeHidden: false}).includeHidden, false);
    assert.throws(() => ListDirectoryArgsSchema.parse({path: root, includeHidden: 'false'}));
    const legacy = await result(root);
    const explicitVisible = await result(root, true);
    assert.deepEqual(explicitVisible, legacy, 'omitted flag changes legacy output');
    assert.ok(legacy.includes('[FILE] .secret'));
    assert.ok(legacy.includes('[DIR] .private'));
    assert.ok(legacy.includes(`[FILE] ${path.join('public', '.inner')}`));
    const filtered = await result(root, false);
    assert.ok(filtered.includes('[FILE] visible.txt'));
    assert.ok(filtered.includes('[DIR] public'));
    assert.ok(filtered.includes(`[FILE] ${path.join('public', 'normal.txt')}`));
    assert.ok(!filtered.some(line => line.includes('.secret') || line.includes('.private') || line.includes('.inner')), JSON.stringify(filtered));
    assert.ok(!filtered.some(line => line.startsWith('[DENIED]')), 'filtered path unexpectedly inaccessible');
    console.log('PASS: list_directory default unchanged; false omits dot entries on all levels');
  } finally {
    fs.rmSync(root, {recursive: true, force: true});
  }
}

runIfMain(import.meta.url, runTests);
