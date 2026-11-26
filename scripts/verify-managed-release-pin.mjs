#!/usr/bin/env node
// Read-only, fail-closed verification of an independently staged managed release.
// This does not register a pin, stop services, release locks, or authorize deployment.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';

const hex = (value, n) => typeof value === 'string' && new RegExp('^[a-f0-9]{' + n + '}$', 'i').test(value);
const equal = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const digest = bytes => createHash('sha256').update(bytes).digest('hex').toUpperCase();
async function json(file) { return JSON.parse((await readFile(file)).toString('utf8').replace(/^\uFEFF/, '')); }

function options(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw Error('Expected --release, --catalog, --repo, --proposal');
    args[argv[i].slice(2)] = argv[i + 1];
  }
  for (const required of ['release', 'catalog', 'repo', 'proposal']) {
    if (!args[required]) throw Error('Missing required --' + required);
  }
  return args;
}
function validateKey(name) {
  if (typeof name !== 'string' || !name || path.isAbsolute(name) || /^[a-z]:/i.test(name)) throw Error('Unsafe manifest path');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) throw Error('Unsafe manifest path');
  return parts.join('/');
}

async function actualFiles(folder) {
  const found = [];
  async function walk(current, prefix = '') {
    for (const ent of await readdir(current, { withFileTypes: true })) {
      const rel = prefix ? prefix + '/' + ent.name : ent.name;
      const full = path.join(current, ent.name);
      const st = await lstat(full);
      if (st.isSymbolicLink()) throw Error('Symlink rejected: ' + rel);
      if (st.isDirectory()) await walk(full, rel);
      else if (st.isFile()) found.push(rel);
      else throw Error('Nonregular release entry: ' + rel);
    }
  }
  await walk(folder);
  return found.sort();
}
async function inventory(folder, hashes) {
  if (!hashes || typeof hashes !== 'object' || Array.isArray(hashes)) throw Error('Missing inventory');
  const expected = new Map();
  for (const [raw, hash] of Object.entries(hashes)) {
    const name = validateKey(raw);
    if (!hex(hash, 64) || expected.has(name.toLowerCase())) throw Error('Invalid or duplicate inventory entry');
    expected.set(name.toLowerCase(), { name, hash });
  }
  if (!expected.size) throw Error('Empty inventory');
  const actual = await actualFiles(folder);
  if (actual.length !== expected.size) throw Error('Inventory count mismatch: ' + folder);
  for (const file of actual) {
    const match = expected.get(file.toLowerCase());
    if (!match || match.name !== file) throw Error('Unexpected release file: ' + file);
    if (!equal(digest(await readFile(path.join(folder, file))), match.hash)) throw Error('Release file digest mismatch: ' + file);
  }
  return actual.length;
}

function reviewedPin(catalog, sha, manifestHash) {
  if (catalog.schema_version !== 1 || catalog.policy !== 'explicitly-reviewed-manifest-sha256' || !Array.isArray(catalog.releases) || !catalog.releases.length)
    throw Error('Invalid Portal trust catalog');
  const seen = new Set();
  for (const pin of catalog.releases) {
    if (!hex(pin.commit, 40) || !hex(pin.manifest_sha256, 64)) throw Error('Invalid trust catalog entry');
    if (seen.has(pin.commit.toLowerCase())) throw Error('Duplicate trust catalog source');
    seen.add(pin.commit.toLowerCase());
  }
  const match = catalog.releases.find(pin => equal(pin.commit, sha));
  if (match && !equal(match.manifest_sha256, manifestHash)) throw Error('Conflicting reviewed digest for source');
  return Boolean(match);
}
export async function verify({ release, catalog, repo, proposal }) {
  const manifestPath = path.join(release, 'manifest.json');
  const bytes = await readFile(manifestPath);
  const manifestHash = digest(bytes);
  const manifest = JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
  const proposed = await json(proposal);
  if (!hex(manifest.source_sha, 40) || !hex(manifest.source_tree, 40)) throw Error('Invalid source identity');
  if (!equal(proposed.commit, manifest.source_sha) || !equal(proposed.manifest_sha256, manifestHash))
    throw Error('Proposal is not bound to exact manifest');
  const tree = execFileSync('git', ['-C', repo, 'rev-parse', manifest.source_sha + '^{tree}'], { encoding: 'utf8' }).trim();
  if (!equal(tree, manifest.source_tree)) throw Error('Source Git tree mismatch');
  const files = {
    staged: await inventory(path.join(release, 'dist-stage'), manifest.candidate_hashes),
    rollback: await inventory(path.join(release, 'dist-before'), manifest.baseline_hashes),
    unpdfStage: await inventory(path.join(release, 'unpdf-stage'), manifest.unpdf_hashes),
    unpdfRollback: await inventory(path.join(release, 'unpdf-before'), manifest.unpdf_hashes),
  };
  if (files.staged !== manifest.candidate_files || files.rollback !== manifest.old_live_files)
    throw Error('Inventory totals differ from manifest');
  const pinned = reviewedPin(await json(catalog), manifest.source_sha, manifestHash);
  return { status: pinned ? 'PIN_VERIFIED' : 'AWAITING_PORTAL_REVIEWED_PIN',
    source: manifest.source_sha, tree, manifestSHA256: manifestHash, files,
    catalogPinPresent: pinned, releaseOwnerClearance: 'not_proven',
    productionPromotionVerified: false, deployAuthorized: false };
}
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:\/)/i, '$1'))) {
  try {
    const result = await verify(options(process.argv.slice(2)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    process.exitCode = result.catalogPinPresent ? 0 : 2;
  } catch (err) {
    process.stderr.write(JSON.stringify({ status: 'BLOCKED', reason: String(err.message) }) + '\n');
    process.exitCode = 3;
  }
}
