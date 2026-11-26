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
    fs.writeFileSync(path.join(root, '.gitignore'), 'ignored.log\nignored-dir/\nbulk-*.skip\n*.tmp\n');
    for (let i = 0; i < 132; i++) {
      fs.writeFileSync(path.join(root, 'bulk-' + String(i).padStart(3, '0') +
        (i === 0 || i === 131 ? '.skip' : '.keep')), 'batch boundary');
    }
    fs.writeFileSync(path.join(root, 'ignored.log'), 'must be omitted');
    fs.mkdirSync(path.join(root, 'ignored-dir'));
    fs.writeFileSync(path.join(root, 'ignored-dir', 'secret.txt'), 'must not recurse');
    fs.mkdirSync(path.join(root, 'only-ignored'));
    fs.writeFileSync(path.join(root, 'only-ignored', 'drop.tmp'), 'ignored file in visible parent');
    fs.mkdirSync(path.join(root, 'ignored-empty'));
    fs.appendFileSync(path.join(root, '.gitignore'), 'ignored-empty/\n');
    fs.writeFileSync(path.join(root, 'tracked.tmp'), 'force tracked even with ignore');
    assert.equal(spawnSync('git', ['-C',root,'add','-f','tracked.tmp']).status, 0);
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
    assert.ok(filtered.includes('[DIR] only-ignored'), 'unignored directory with only ignored files must stay visible');
    assert.ok(filtered.includes('[FILE] tracked.tmp'), 'tracked files matching ignore pattern must remain visible');
    assert.ok(!filtered.some(line => line.includes('ignored-empty')),
      'explicitly ignored empty directories must be hidden');
    assert.ok(!filtered.some(line => line.includes(path.join('only-ignored','drop.tmp'))),
      'ignored contents of a visible parent must be hidden');
    assert.ok(filtered.includes('[FILE] ' + path.join('nested', 'keep.tmp')));
    assert.ok(filtered.includes('[DIR] ' + path.join('nested', 'empty')), 'empty dirs must remain');
    assert.ok(!filtered.some(line => ['ignored.log', 'drop.tmp', 'ignored-dir', 'local-only.cache', 'bulk-000.skip', 'bulk-131.skip']
      .some(name => line.includes(name))), JSON.stringify(filtered));
    assert.ok(filtered.includes('[FILE] bulk-001.keep'));
    assert.ok(filtered.includes('[FILE] bulk-130.keep'));
    assert.equal(filtered.some(line => line.startsWith('[DENIED]')), false);
    const ignoredDirect = await handleListDirectory({
      path: path.join(root, 'ignored-dir'), depth: 2, respectGitignore: true
    });
    assert.notEqual(ignoredDirect.isError, true, JSON.stringify(ignoredDirect));
    assert.ok(!ignoredDirect.content[0].text.includes('secret.txt'),
      'explicit listing beneath an ignored ancestor must not leak contents or fail');
    const visibleDirect = await handleListDirectory({
      path: path.join(root, 'only-ignored'), depth: 2, respectGitignore: true
    });
    assert.notEqual(visibleDirect.isError, true, JSON.stringify(visibleDirect));
    assert.ok(!visibleDirect.content[0].text.includes('drop.tmp'));
    if (process.platform === 'win32') {
      const alias = path.join(root, 'alias-to-ignored');
      fs.symlinkSync(path.join(root, 'ignored-dir'), alias, 'junction');
      const aliasResult = await handleListDirectory({ path: root, depth: 3, respectGitignore: true });
      assert.notEqual(aliasResult.isError, true, JSON.stringify(aliasResult));
      assert.ok(!aliasResult.content[0].text.includes(path.join('alias-to-ignored', 'secret.txt')),
        'in-scope junction must not bypass ignored-ancestor exclusion');
    }
    if (process.platform === 'win32') {
      const embeddedRoot = path.join(root, 'embedded-repo');
      const embeddedSubdir = path.join(embeddedRoot, 'work');
      fs.mkdirSync(embeddedRoot);
      assert.equal(spawnSync('git', ['init', '-q', embeddedRoot]).status, 0);
      fs.writeFileSync(path.join(embeddedRoot, '.gitignore'), '*.cache\n');
      fs.mkdirSync(embeddedSubdir);
      fs.writeFileSync(path.join(embeddedSubdir, 'private.cache'), 'hidden by inner repo');
      fs.writeFileSync(path.join(embeddedSubdir, 'visible.data'), 'keep');
      fs.symlinkSync(embeddedSubdir, path.join(root, 'alias-inside-embedded'), 'junction');
      const linkResult = await handleListDirectory({ path: root, depth: 3, respectGitignore: true });
      assert.notEqual(linkResult.isError, true, JSON.stringify(linkResult));
      assert.ok(linkResult.content[0].text.includes(path.join('alias-inside-embedded', 'visible.data')));
      assert.ok(!linkResult.content[0].text.includes(path.join('alias-inside-embedded', 'private.cache')),
        'resolved junction into descendant of nested repository must adopt inner ignore rules');
    }
    const outside = createTempDir('dc-list-no-git-');
    try {
      fs.writeFileSync(path.join(outside, 'ordinary.txt'), 'not a repository');
      const response = await handleListDirectory({ path: outside, respectGitignore: true });
      assert.notEqual(response.isError, true, JSON.stringify(response));
      assert.ok(response.content[0].text.includes('[FILE] ordinary.txt'));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
    // A nested Git repository has its own ignore scope. Force its lookup to
    // fail after the outer query to prove no partial-success response escapes.
    const nestedRepo = spawnSync('git', ['init', '-q', path.join(root, 'nested')], { encoding: 'utf8' });
    assert.equal(nestedRepo.status, 0, nestedRepo.stderr);
    fs.writeFileSync(path.join(root, 'nested', 'independent.tmp'),
      'new Git repository ignores are independent');
    // A nested .gitignore overrides the ancestor's ignore scope on traversal.
    const nestedOk = await handleListDirectory({ path: root, depth: 3, respectGitignore: true });
    assert.notEqual(nestedOk.isError, true, JSON.stringify(nestedOk));
    assert.ok(nestedOk.content[0].text.includes(path.join('nested', 'keep.tmp')),
      'nested repository exception must remain visible');
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
