import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handleListDirectory } from '../dist/handlers/filesystem-handlers.js';
import { ListDirectoryArgsSchema } from '../dist/tools/schemas.js';
import { createTempDir } from './helpers/test-env.js';
import { runIfMain } from './helpers/run-if-main.js';

async function run() {
  const root = createTempDir('dc-list-gitignore-');
  try {
    const initialized = spawnSync('git', ['init', '-q', root], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.log\nignored-dir/\nbulk-*.skip\n');
    for (let i = 0; i < 132; i++) {
      fs.writeFileSync(path.join(root, 'bulk-' + String(i).padStart(3, '0') +
        (i === 0 || i === 131 ? '.skip' : '.keep')), 'batch boundary');
    }
    fs.writeFileSync(path.join(root, 'ignored.log'), 'must be omitted');
    fs.mkdirSync(path.join(root, 'ignored-dir'));
    fs.writeFileSync(path.join(root, 'ignored-dir', 'secret.txt'), 'must not recurse');
    fs.writeFileSync(path.join(root, '.git', 'info', 'exclude'), 'local-only.cache\n');
    fs.writeFileSync(path.join(root, 'local-only.cache'), 'local exclude');
    fs.writeFileSync(path.join(root, 'visible.txt'), 'must remain');
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'nested', '.gitignore'), '*.tmp\n!keep.tmp\n');
    fs.writeFileSync(path.join(root, 'nested', 'drop.tmp'), 'must be omitted');
    fs.writeFileSync(path.join(root, 'nested', 'keep.tmp'), 'negation must survive');
    fs.mkdirSync(path.join(root, 'nested', 'empty'));
    const invoke = async (respectGitignore) => {
      const response = await handleListDirectory({ path: root, depth: 3, respectGitignore });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      return response.content[0].text.split('\n');
    };
    assert.equal(ListDirectoryArgsSchema.parse({ path: root }).respectGitignore, false);
    assert.throws(() => ListDirectoryArgsSchema.parse({ path: root, respectGitignore: 'true' }));
    const legacy = await invoke(undefined);
    assert.ok(legacy.includes('[FILE] ignored.log'), 'default must preserve legacy output');
    const filtered = await invoke(true);
    assert.ok(filtered.includes('[FILE] visible.txt'));
    assert.ok(filtered.includes('[FILE] ' + path.join('nested', 'keep.tmp')));
    assert.ok(filtered.includes('[DIR] ' + path.join('nested', 'empty')), 'empty dirs must remain');
    assert.ok(!filtered.some(line => ['ignored.log', 'drop.tmp', 'ignored-dir', 'local-only.cache', 'bulk-000.skip', 'bulk-131.skip']
      .some(name => line.includes(name))), JSON.stringify(filtered));
    assert.ok(filtered.includes('[FILE] bulk-001.keep'));
    assert.ok(filtered.includes('[FILE] bulk-130.keep'));
    assert.equal(filtered.some(line => line.startsWith('[DENIED]')), false);
    const outside = createTempDir('dc-list-no-git-');
    try {
      fs.writeFileSync(path.join(outside, 'ordinary.txt'), 'not a repository');
      const response = await handleListDirectory({ path: outside, respectGitignore: true });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.ok(response.content[0].text.includes('[FILE] ordinary.txt'));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    const fsp = (await import('node:fs/promises')).default;
    const originalReaddir = fsp.readdir;
    const originalPath = process.env.PATH;
    try {
      fsp.readdir = async (target, ...rest) => {
        const items = await originalReaddir.call(fsp, target, ...rest);
        if (path.resolve(String(target)) === path.resolve(path.join(root, 'nested')))
          process.env.PATH = path.join(root, 'nonexistent-bin');
        return items;
      };
      const nestedError = await handleListDirectory({ path: root, depth: 3, respectGitignore: true });
      assert.equal(nestedError.isError, true, 'nested Git failure must not silently truncate a successful listing');
    } finally { fsp.readdir = originalReaddir; process.env.PATH = originalPath; }
    const savedPath = process.env.PATH;
    try {
      process.env.PATH = path.join(root, 'nonexistent-bin');
      const failure = await handleListDirectory({ path: root, respectGitignore: true });
      assert.equal(failure.isError, true, 'missing git must fail the requested filtered listing');
      const legacyWithoutGit = await handleListDirectory({ path: root });
      assert.notEqual(legacyWithoutGit.isError, true, 'ordinary listing must not require git');
    } finally { process.env.PATH = savedPath; }
    console.log('PASS: Git rules, multi-batch boundaries, non-repo fallback and fail-closed errors');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
runIfMain(import.meta.url, run);
