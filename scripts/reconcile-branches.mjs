#!/usr/bin/env node
/**
 * DeskCommand branch/worktree reconciliation.
 * Read-only by default. An explicit single-branch retirement requires an
 * exact SHA, a verified bundle, a clean checkout and zero open pull requests.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROTECTED = [
  /^main$/, /^HEAD$/, /^codex\//, /^lane\//,
  /^reconcile\//, /^release\//,
];
const MAX_SQUASH_PATHSPEC_BYTES = 16000;
const MAX_SQUASH_CANDIDATES = 2000;
const DEFAULT_FORK = 'insane66613/DesktopCommanderMCP';
const DEFAULT_UPSTREAM = 'wonderwhy-er/DesktopCommanderMCP';

function run(command, args, cwd, options = {}) {
  const result = spawnSync(command, args, {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || (result.status !== 0 && !options.allowFailure)) {
    const detail = (result.stderr || result.error?.message || '').slice(0, 800);
    throw new Error(command + ' ' + args.join(' ') + ': ' + detail);
  }
  return { out: (result.stdout || '').trim(), status: result.status, err: (result.stderr || '').trim() };
}
function git(args, cwd, options = {}) { return run('git', args, cwd, options); }
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}
function sha256Text(value) {
  return createHash('sha256').update(value,'utf8').digest('hex');
}
function durableJson(path, record, flag = 'w') {
  const fd = openSync(path, flag);
  try {
    writeFileSync(fd, JSON.stringify(record, null, 2) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
}
function parseArgs(args) {
  const parsed = { remote: 'fork', json: false, apply: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') { parsed.json = true; continue; }
    if (arg === '--hotspots') { parsed.hotspots = true; continue; }
    if (arg === '--help') { parsed.help = true; continue; }
    if (arg === '--apply') { parsed.apply = true; continue; }
    if (arg === '--allow-patch-equivalent') { parsed.allowPatch = true; continue; }
    const key = { '--remote':'remote', '--output':'output', '--retire':'retire',
      '--expect-sha':'expectSha', '--archive-dir':'archiveDir',
      '--fork-repo':'forkRepo', '--upstream-repo':'upstreamRepo' }[arg];
    if (!key || i + 1 >= args.length) { throw new Error('Unknown/incomplete argument: ' + arg); }
    parsed[key] = args[++i];
  }
  if (parsed.help) return parsed;
  if (parsed.apply && (!parsed.retire || !parsed.archiveDir || !parsed.expectSha)) {
    throw new Error('--apply requires --retire, --archive-dir and --expect-sha');
  }
  if (parsed.retire && !parsed.apply) {
    throw new Error('--retire requires --apply; default mode only audits');
  }
  if (parsed.expectSha && !/^[0-9a-f]{40}$/i.test(parsed.expectSha)) {
    throw new Error('--expect-sha must be a complete 40-character commit SHA');
  }
  if (!/^[\w.-]+$/.test(parsed.remote)) throw new Error('Invalid remote name');
  return parsed;
}
export function classifyBranch(input) {
  if (input.protected || input.checkedOut) return 'PROTECTED';
  if (!input.objectPresent || !input.trackingMatches) return 'UNFETCHED_OR_MOVED';
  if (input.inMain) return 'MERGED_IN_MAIN';
  if (input.uniqueMerges === 0 &&
      (input.uniquePatches === 0 || input.squashEquivalentCommit)) {
    return 'PATCH_EQUIVALENT_CANDIDATE';
  }
  return 'UNIQUE_REVIEW';
}
export function retirementAllowed(item, opts = {}) {
  if (!item || item.checkedOut || item.protected) return false;
  if (!item.trackingMatches || !item.objectPresent) return false;
  if (item.classification === 'MERGED_IN_MAIN') return true;
  return item.classification === 'PATCH_EQUIVALENT_CANDIDATE' && !!opts.allowPatch;
}
function worktrees(cwd) {
  return git(['worktree','list','--porcelain'], cwd).out.split(/\r?\n\r?\n/)
    .map(block => Object.fromEntries(block.split(/\r?\n/).filter(Boolean)
      .map(line => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])))
    .filter(x => x.worktree);
}
function exactSquashAdoption(cwd, mainSha, branchSha, mergeBase, diffCache) {
  const branchDiff = git(['diff-tree','--no-commit-id','--raw','-r','-z',
    '--no-renames','--no-abbrev',mergeBase,branchSha],cwd).out;
  if (!branchDiff) return {commit:null,status:'empty-diff'};
  const paths = git(['diff-tree','--no-commit-id','--name-only','-r','-z',
    '--no-renames',mergeBase,branchSha],cwd).out.split('\0').filter(Boolean);
  if (!paths.length) return {commit:null,status:'empty-diff'};
  const pathBytes = paths.reduce((total,path) => total + Buffer.byteLength(path,'utf8') + 1,0);
  if (pathBytes > MAX_SQUASH_PATHSPEC_BYTES) {
    return {commit:null,status:'path-limit-exceeded'};
  }
  const candidates = git(['--literal-pathspecs','rev-list','--no-merges',
    mergeBase + '..' + mainSha,'--',...paths],cwd).out.split(/\r?\n/).filter(Boolean);
  if (candidates.length > MAX_SQUASH_CANDIDATES) {
    return {commit:null,status:'candidate-limit-exceeded'};
  }
  const branchDigest = sha256Text(branchDiff);
  for (const commit of candidates) {
    let digest = diffCache.get(commit);
    let candidateDiff = null;
    if (digest === undefined || digest === branchDigest) {
      const parent = git(['rev-parse',commit + '^'],cwd).out;
      candidateDiff = git(['diff-tree','--no-commit-id','--raw','-r','-z',
        '--no-renames','--no-abbrev',parent,commit],cwd).out;
      if (digest === undefined) {
        digest = sha256Text(candidateDiff);
        diffCache.set(commit,digest);
      }
    }
    if (digest === branchDigest && candidateDiff === branchDiff) {
      return {commit,status:'exact-match'};
    }
  }
  return {commit:null,status:'no-match'};
}
function branches(cwd, remote, baseSha, wts) {
  const rows = git(['ls-remote','--heads',remote], cwd).out.split(/\r?\n/).filter(Boolean);
  const diffCache = new Map();
  return rows.map(line => {
    const [sha, ref] = line.trim().split(/\s+/);
    const name = ref.slice('refs/heads/'.length);
    const local = git(['rev-parse','--verify','refs/remotes/' + remote + '/' + name], cwd, {allowFailure:true});
    const trackingMatches = local.status === 0 && local.out === sha;
    const objectPresent = git(['cat-file','-e',sha + '^{commit}'], cwd, {allowFailure:true}).status === 0;
    const protectedBranch = PROTECTED.some(pattern => pattern.test(name));
    const checkedOut = wts.some(w => w.branch === 'refs/heads/' + name);
    const item = { name, sha, trackingMatches, objectPresent,
      checkedOut, protected: protectedBranch, inMain: false, mergeBase: null,
      uniquePatches: null, uniqueMerges: null,
      squashEquivalentCommit: null, squashCheck: 'not-checked' };
    if (trackingMatches && objectPresent) {
      item.inMain = git(['merge-base','--is-ancestor',sha,baseSha], cwd,
        {allowFailure:true}).status === 0;
      const mergeBase = git(['merge-base',baseSha,sha],cwd,{allowFailure:true});
      item.mergeBase = mergeBase.status === 0 ? mergeBase.out : null;
      const patches = git(['rev-list','--right-only','--cherry-pick',
        '--no-merges',baseSha + '...' + sha],cwd).out;
      const merges = git(['rev-list','--merges',baseSha + '..' + sha],cwd).out;
      item.uniquePatches = patches ? patches.split(/\r?\n/).length : 0;
      item.uniqueMerges = merges ? merges.split(/\r?\n/).length : 0;
      if (item.uniqueMerges > 0) {
        item.squashCheck = 'unique-merges-present';
      } else if (item.uniquePatches > 0 && item.mergeBase) {
        const squash = exactSquashAdoption(cwd,baseSha,sha,item.mergeBase,diffCache);
        item.squashEquivalentCommit = squash.commit;
        item.squashCheck = squash.status;
      } else if (item.uniquePatches > 0) {
        item.squashCheck = 'no-common-base';
      } else {
        item.squashCheck = 'not-needed';
      }
    }
    item.classification = classifyBranch(item);
    return item;
  });
}
/**
 * An optional, bounded source-overlap report. File overlap is a review hint,
 * never proof that two branches are patch- or behavior-equivalent.
 */
export function summarizeHotspots(items) {
  const byPath = new Map();
  for (const item of items) {
    if (!Array.isArray(item.changedPaths)) continue;
    for (const path of item.changedPaths) {
      if (!byPath.has(path)) byPath.set(path, new Set());
      byPath.get(path).add(item.name);
    }
  }
  return [...byPath.entries()].filter(([,names]) => names.size > 1)
    .map(([path,names]) => ({ path, branchCount:names.size,
      branches:[...names].sort() }))
    .sort((a,b) => b.branchCount-a.branchCount || a.path.localeCompare(b.path))
    .slice(0,50);
}
function addHotspots(cwd, mainSha, result) {
  let sampled = 0;
  for (const item of result.branches) {
    if (!item.trackingMatches || !item.objectPresent || !item.uniquePatches ||
        item.squashEquivalentCommit) continue;
    // -z disambiguates paths containing spaces or newlines. Do not infer
    // semantic duplicates from path overlap, and include protected PR branches.
    const output = git(['log','--right-only','--cherry-pick','--no-merges',
      '--format=','--name-only','-z',mainSha + '...' + item.sha],cwd).out;
    const paths = [...new Set(output.split('\0').map(s=>s.trim()).filter(Boolean))].sort();
    item.changedPaths = paths;
    item.changedPathCount = paths.length;
    sampled++;
  }
  result.hotspots = summarizeHotspots(result.branches);
  result.hotspotScope = {reviewedBranches:sampled, totalPaths:
    new Set(result.branches.flatMap(item => item.changedPaths || [])).size,
    disclaimer:'Same file paths imply overlapping review surface, not duplicate code or deletion approval'};
}
export function openPrs(cwd, owner, branch, repos) {
  const results = [];
  for (const repo of repos) {
    // Do not use gh --head=owner:branch here: that filter misses some fork PRs.
    const args = ['pr','list','--repo',repo,'--state','open','--limit','1000',
      '--json','number,headRefName,headRepositoryOwner'];
    const res = run('gh',args,cwd);
    const found = JSON.parse(res.out || '[]');
    if (!Array.isArray(found) || found.length >= 1000) {
      throw new Error('GitHub PR coverage incomplete or unexpected');
    }
    results.push(...found.filter(pr =>
      pr.headRefName === branch &&
      pr.headRepositoryOwner?.login?.toLowerCase() === owner.toLowerCase()
    ).map(pr => ({repo, ...pr})));
  }
  return results;
}
export function verifyBundleRecovery(bundle, mainSha, branchSha, cwd) {
  const temp = mkdtempSync(join(dirname(bundle), '.recovery-check-'));
  try {
    const bare = join(temp, 'restored.git');
    git(['clone','--bare',bundle,bare],cwd);
    for (const sha of [mainSha,branchSha]) {
      git(['cat-file','-e',sha + '^{commit}'],bare);
    }
    if (git(['rev-parse','refs/heads/main'],bare).out !== mainSha) {
      throw new Error('Bundle clone restored the wrong main commit');
    }
  } finally {
    rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
function retire(cwd, args, item, mainSha, wts) {
  if (!retirementAllowed(item, {allowPatch:args.allowPatch})) {
    throw new Error('Branch is not an eligible, explicitly reviewed retirement');
  }
  if (item.sha.toLowerCase() !== args.expectSha.toLowerCase()) {
    throw new Error('Remote head does not match supplied expected SHA');
  }
  if (wts.some(w => w.branch === 'refs/heads/' + item.name)) {
    throw new Error('Branch checked out in a worktree');
  }
  if (git(['status','--porcelain','-uall'],cwd).out) {
    throw new Error('Working tree dirty; retirement blocked');
  }
  const owner = (args.forkRepo || DEFAULT_FORK).split('/')[0];
  const prs = openPrs(cwd, owner, item.name, [
    args.forkRepo || DEFAULT_FORK, args.upstreamRepo || DEFAULT_UPSTREAM,
  ]);
  if (prs.length) throw new Error('Open pull requests protect this branch: ' + JSON.stringify(prs));
  const ref = 'refs/heads/' + item.name;
  const remoteHead = git(['ls-remote',args.remote,ref],cwd).out.split(/\s+/)[0];
  if (remoteHead !== item.sha) throw new Error('Remote tip moved before bundle');
  const archiveDir = resolve(args.archiveDir);
  mkdirSync(archiveDir, { recursive: true });
  const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g,'_');
  const id = safeName + '-' + item.sha.slice(0,12);
  const bundle = join(archiveDir,id + '.bundle');
  const receipt = join(archiveDir,id + '.json');
  if (existsSync(bundle) || existsSync(receipt)) {
    throw new Error('Archive or receipt already exists; never overwrite');
  }
  git(['bundle','create',bundle,'refs/heads/main',
    'refs/remotes/' + args.remote + '/' + item.name],cwd);
  git(['bundle','verify',bundle],cwd);
  const heads = git(['bundle','list-heads',bundle],cwd).out;
  if (!heads.includes(item.sha) || !heads.includes(mainSha)) {
    throw new Error('Bundle does not contain the expected complete branch heads');
  }
  verifyBundleRecovery(bundle, mainSha, item.sha, cwd);
  const record = { state:'PREPARED', preparedAt:new Date().toISOString(),
    main:mainSha, remote:args.remote,
    branch:item, bundle, bundleSha256:sha256(bundle), heads,
    openPrs:prs, restoredBy:'git fetch ' + bundle + ' ' +
      'refs/remotes/' + args.remote + '/' + item.name + ':refs/heads/recovered/' + safeName };
  durableJson(receipt,record,'wx');
  // PRs may have opened during archive validation. Re-read both repositories.
  if (openPrs(cwd,owner,item.name,[args.forkRepo || DEFAULT_FORK,
    args.upstreamRepo || DEFAULT_UPSTREAM]).length) {
    throw new Error('Open PR appeared before deletion; preserved PREPARED archive');
  }
  if (git(['status','--porcelain','-uall'],cwd).out ||
      worktrees(cwd).some(w => w.branch === 'refs/heads/' + item.name)) {
    throw new Error('Worktree changed before deletion');
  }
  const beforeDelete = git(['ls-remote',args.remote,ref],cwd).out.split(/\s+/)[0];
  if (beforeDelete !== item.sha || sha256(bundle) !== record.bundleSha256) {
    throw new Error('Archive or remote changed before deletion');
  }
  git(['push','--atomic','--force-with-lease=' + ref + ':' + item.sha,
    args.remote,':' + ref],cwd);
  if (git(['ls-remote',args.remote,ref],cwd).out) {
    throw new Error('Remote still contains deleted branch; inspect receipt');
  }
  record.state = 'DELETED_VERIFIED';
  record.retiredAt = new Date().toISOString();
  durableJson(receipt,record);
  return {state:record.state, branch:item.name, bundle, receipt, sha256:record.bundleSha256};
}
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/reconcile-branches.mjs [--remote fork] [--json] [--output NEW_REPORT.json]');
    console.log('  Read-only branch, worktree, patch and stale-ref audit by default.');
    console.log('  Optional --hotspots: list changed files and overlapping branch paths (not equivalence)');
    console.log('  Retirement: --apply --retire BRANCH --expect-sha FULL_SHA --archive-dir PATH');
    console.log('  Extra approval for proven equivalent patches: --allow-patch-equivalent');
    return;
  }
  const cwd = process.cwd();
  const mainSha = git(['rev-parse','refs/heads/main'],cwd).out;
  const wts = worktrees(cwd);
  const result = {main:mainSha,remote:args.remote,worktrees:wts,
    staleWorktrees:git(['worktree','prune','--dry-run','--verbose'],cwd).err,
    staleTracking:git(['remote','prune','--dry-run',args.remote],cwd).out,
    branches:branches(cwd,args.remote,mainSha,wts)};
  const groups = Object.groupBy(result.branches, item => item.classification);
  result.summary = Object.fromEntries(Object.entries(groups).map(([k,v]) => [k,v.length]));
  if (args.hotspots) addHotspots(cwd,mainSha,result);
  if (args.output) {
    const target = resolve(args.output);
    mkdirSync(dirname(target), {recursive:true});
    writeFileSync(target,JSON.stringify(result,null,2) + '\n',{flag:'wx'});
  }
  if (args.retire) {
    const item = result.branches.find(b => b.name === args.retire);
    result.retirement = retire(cwd,args,item,mainSha,wts);
  }
  if (args.json) console.log(JSON.stringify(result,null,2));
  else {
    console.log('main=' + mainSha + ' worktrees=' + wts.length +
      ' remote-heads=' + result.branches.length);
    for (const [kind,count] of Object.entries(result.summary)) {
      console.log(kind + ': ' + count);
    }
    if (args.hotspots) {
      console.log('overlap-hotspots=' + result.hotspots.length + ' reviewed-branches=' + result.hotspotScope.reviewedBranches);
      for (const h of result.hotspots.slice(0,15)) console.log(h.branchCount + ' branches: ' + h.path);
    }
    if (result.retirement) console.log(JSON.stringify(result.retirement));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(err => { console.error('RECONCILE FAILED: ' + err.message); process.exitCode=1; });
}
