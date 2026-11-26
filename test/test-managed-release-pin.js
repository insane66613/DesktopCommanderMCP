import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { verify } from '../scripts/verify-managed-release-pin.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dc-pin-verification-'));
  const repo = join(root, 'repo'), release = join(root, 'release');
  await mkdir(repo); await mkdir(release);
  execFileSync('git', ['init', '-b', 'main', repo]);
  await writeFile(join(repo, 'source.txt'), 'pinned source');
  git(repo, 'add', 'source.txt');
  git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const source = git(repo, 'rev-parse', 'HEAD'), tree = git(repo, 'rev-parse', 'HEAD^{tree}');
  const files = { 'dist-stage': 'stage', 'dist-before': 'rollback',
    'unpdf-stage': 'vendor', 'unpdf-before': 'vendor' };
  for (const [folder, content] of Object.entries(files)) {
    await mkdir(join(release, folder));
    await writeFile(join(release, folder, 'payload.txt'), content);
  }
  const stage = sha('stage'), rollback = sha('rollback'), vendor = sha('vendor');
  const manifest = { source_sha: source, source_tree: tree, candidate_files: 1, old_live_files: 1,
    candidate_hashes: { 'payload.txt': stage }, baseline_hashes: { 'payload.txt': rollback },
    unpdf_hashes: { 'payload.txt': vendor } };
  const manifestFile = join(release, 'manifest.json');
  await writeFile(manifestFile, JSON.stringify(manifest));
  const proposal = join(root, 'proposal.json'), catalog = join(root, 'catalog.json');
  const expected = sha(await readFile(manifestFile));
  await writeFile(proposal, JSON.stringify({ commit: source, manifest_sha256: expected }));
  const unrelated = 'a'.repeat(40), otherDigest = 'b'.repeat(64);
  const entries = [{ commit: unrelated, manifest_sha256: otherDigest }];
  const writeCatalog = async pins => writeFile(catalog, JSON.stringify({
    schema_version: 1, policy: 'explicitly-reviewed-manifest-sha256', releases: pins }));
  await writeCatalog(entries);
  return { root, repo, release, proposal, catalog, manifestFile, manifest, source, expected, entries, writeCatalog };
}

test('valid evidence reports missing reviewed pin without granting release', async () => {
  const f = await fixture();
  const result = await verify(f);
  assert.equal(result.status, 'AWAITING_PORTAL_REVIEWED_PIN');
  assert.deepEqual(result.files, { staged: 1, rollback: 1, unpdfStage: 1, unpdfRollback: 1 });
  assert.equal(result.catalogPinPresent, false);
  assert.equal(result.productionPromotionVerified, false);
  assert.equal(result.deployAuthorized, false);
});
test('exact reviewed digest is accepted but does not authorize promotion', async () => {
  const f = await fixture();
  await f.writeCatalog([...f.entries, { commit: f.source, manifest_sha256: f.expected }]);
  const result = await verify(f);
  assert.equal(result.status, 'PIN_VERIFIED');
  assert.equal(result.catalogPinPresent, true);
  assert.equal(result.deployAuthorized, false);
});

test('conflicting reviewed digest fails closed', async () => {
  const f = await fixture();
  await f.writeCatalog([...f.entries, { commit: f.source, manifest_sha256: 'c'.repeat(64) }]);
  await assert.rejects(verify(f), /Conflicting reviewed digest/);
});

test('tampered staged files fail SHA-256 verification', async () => {
  const f = await fixture();
  await writeFile(join(f.release, 'dist-stage', 'payload.txt'), 'tampered');
  await assert.rejects(verify(f), /digest mismatch/);
});

test('duplicate catalog commit and unsafe inventory path both fail closed', async () => {
  const f = await fixture();
  await f.writeCatalog([...f.entries, ...f.entries]);
  await assert.rejects(verify(f), /Duplicate trust catalog/);
  await f.writeCatalog(f.entries);
  f.manifest.candidate_hashes = { '../escape.txt': sha('stage') };
  await writeFile(f.manifestFile, JSON.stringify(f.manifest));
  await writeFile(f.proposal, JSON.stringify({ commit: f.source, manifest_sha256: sha(await readFile(f.manifestFile)) }));
  await assert.rejects(verify(f), /Unsafe manifest path/);
});
test('incorrect source tree fails before any release endorsement', async () => {
  const f = await fixture();
  f.manifest.source_tree = '1'.repeat(40);
  await writeFile(f.manifestFile, JSON.stringify(f.manifest));
  await writeFile(f.proposal, JSON.stringify({ commit: f.source, manifest_sha256: sha(await readFile(f.manifestFile)) }));
  await assert.rejects(verify(f), /Source Git tree mismatch/);
});

test('CLI exit 2 and structured status for missing reviewed catalog pin', async () => {
  const f = await fixture();
  const script = fileURLToPath(new URL('../scripts/verify-managed-release-pin.mjs', import.meta.url));
  const command = spawnSync(process.execPath, [script,
    '--release', f.release, '--catalog', f.catalog, '--repo', f.repo, '--proposal', f.proposal],
  { encoding: 'utf8', windowsHide: true });
  assert.equal(command.status, 2, command.stderr);
  assert.equal(JSON.parse(command.stdout).status, 'AWAITING_PORTAL_REVIEWED_PIN');
});
