#!/usr/bin/env node
/**
 * DeskCommand branch/worktree reconciliation.
 * Read-only by default. An explicit single-branch retirement requires an
 * exact SHA, a verified bundle, a clean checkout and zero open pull requests.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, openSync, fsyncSync, closeSync, mkdtempSync, rmSync, lstatSync, copyFileSync, constants as fsConstants } from 'node:fs';
import { dirname, resolve, join, isAbsolute } from 'node:path';
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
  return { out: options.raw ? (result.stdout || '') : (result.stdout || '').trim(), status: result.status, err: (result.stderr || '').trim() };
}
function git(args, cwd, options = {}) { return run('git', args, cwd, options); }
function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex').toUpperCase();
}
// Read and hash the SAME bytes used for the retirement decision. Symlinked
// review inputs, mutable hard links, and path substitution fail closed.
function pinnedEvidence(path, expectedSha256) {
  if (!isAbsolute(path) || !/^[0-9a-f]{64}$/i.test(expectedSha256 || '')) {
    throw new Error('Evidence requires absolute path and complete SHA256');
  }
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Review evidence is not an isolated regular file');
  }
  const bytes = readFileSync(path);
  const after = lstatSync(path);
  if (before.dev !== after.dev || before.ino !== after.ino ||
      before.size !== after.size || bytes.length !== after.size) {
    throw new Error('Review evidence file changed while reading');
  }
  const actual = createHash('sha256').update(bytes).digest('hex').toUpperCase();
  if (actual !== expectedSha256.toUpperCase()) {
    throw new Error('Review evidence SHA256 mismatch');
  }
  return {bytes,sha256:actual};
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
    if (arg === '--approve-current-semantics') { parsed.approveCurrent = true; continue; }
    if (arg === '--allow-patch-equivalent') { parsed.allowPatch = true; continue; }
    if (arg === '--allow-semantic-supersession') { parsed.allowSemantic = true; continue; }
    const key = { '--remote':'remote', '--output':'output', '--retire':'retire',
      '--expect-sha':'expectSha', '--expect-main':'expectMain', '--archive-dir':'archiveDir',
      '--fork-repo':'forkRepo', '--upstream-repo':'upstreamRepo',
      '--review-receipt':'reviewReceipt', '--review-sha256':'reviewSha256' }[arg];
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
  if (parsed.apply && (!parsed.expectMain || !parsed.approveCurrent)) {
    throw new Error('--apply requires --expect-main and --approve-current-semantics (exact current semantic and consumer review)');
  }
  if (parsed.expectMain && !/^[0-9a-f]{40}$/i.test(parsed.expectMain)) {
    throw new Error('--expect-main must be a complete 40-character commit SHA');
  }
  if (parsed.expectSha && !/^[0-9a-f]{40}$/i.test(parsed.expectSha)) {
    throw new Error('--expect-sha must be a complete 40-character commit SHA');
  }
  if (parsed.allowSemantic && (!parsed.reviewReceipt || !/^[0-9a-f]{64}$/i.test(parsed.reviewSha256 || ''))) {
    throw new Error('Semantic retirement requires --review-receipt and --review-sha256 (exact 64-character hash)');
  }
  if ((parsed.reviewReceipt || parsed.reviewSha256) && !parsed.allowSemantic) {
    throw new Error('Review receipt requires --allow-semantic-supersession');
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
// Historical semantics are not established by file overlap or a Git patch hash.
// A separate exact-SHA review attestation is required to retire a UNIQUE_REVIEW branch.
export function semanticReviewApproved(item, review) {
  if (item?.classification !== 'UNIQUE_REVIEW' || !review || review.schemaVersion !== 1 ||
      review.decision !== 'APPROVED_SEMANTICALLY_SUPERSEDED' ||
      review.branch !== item.name || review.branchSha !== item.sha ||
      review.mainSha !== item.mainSha ||
      review.ownerApproval?.authorization !== 'OWNER_DIRECTIVE_BRANCH_RETIREMENT' ||
      !review.ownerApproval?.sourceInstruction ||
      review.unresolvedFeatureGaps !== 0 ||
      review.consumerAudit?.status !== 'NO_ACTIVE_CONSUMERS' ||
      !Array.isArray(review.consumerAudit.scopes) ||
      !['repository','automation','deployment'].every(scope=>review.consumerAudit.scopes.includes(scope)) ||
      !Array.isArray(review.commitMap) || review.commitMap.length === 0 ||
      !Array.isArray(review.reviewEvidence) || review.reviewEvidence.length < 2 ||
      review.reviewEvidence.some(e => !e.kind || !e.sourceId ||
        !isAbsolute(e.path || '') || !/^[0-9a-f]{64}$/i.test(e.sha256 || '')) ||
      new Set(review.reviewEvidence.map(e=>e.sha256.toUpperCase())).size !==
        review.reviewEvidence.length ||
      !Array.isArray(review.knownDifferences) ||
      review.knownDifferences.some(d => !d.behavior || !d.affectedInterface ||
        !['REPLACED','INTENTIONALLY_RETIRED'].includes(d.currentDisposition) ||
        !d.rationale || !d.testEvidence || !d.rollbackConsequence ||
        d.ownerApproved !== true)) {
    return false;
  }
  return review.commitMap.every(c => /^[0-9a-f]{40}$/.test(c.sha || '') &&
    typeof c.current === 'string' && c.current.length >= 8 &&
    typeof c.sourcePath === 'string' && c.sourcePath.length > 2 &&
    typeof c.testEvidence === 'string' && c.testEvidence.length >= 8 &&
    ['ADOPTED_AND_EXTENDED','ADOPTED_ROUTING_REPLACED','INTENTIONALLY_RETIRED'].includes(c.classification));
}
export function loadSemanticReview(cwd, item, args) {
  if (item?.classification !== 'UNIQUE_REVIEW') throw new Error('Semantic review requires UNIQUE_REVIEW branch');
  const path = resolve(args.reviewReceipt);
  const pinned = pinnedEvidence(path,args.reviewSha256);
  const checksum = pinned.sha256;
  const review = JSON.parse(pinned.bytes.toString('utf8'));
  for (const evidence of review.reviewEvidence || []) {
    pinnedEvidence(evidence.path,evidence.sha256);
  }
  if (!semanticReviewApproved(item, review)) throw new Error('Semantic retirement evidence incomplete or stale');
  if (review.commitMap.some(c=>c.sourcePath.includes('..') ||
      !existsSync(resolve(cwd,c.sourcePath)))) {
    throw new Error('Commit successor file missing or outside repository');
  }
  const commits = git(['rev-list','--no-merges',item.mainSha + '..' + item.sha],cwd)
    .out.split(/\r?\n/).filter(Boolean).sort();
  const merges = git(['rev-list','--merges',item.mainSha + '..' + item.sha],cwd).out;
  const mapped = review.commitMap.map(c => c.sha).sort();
  if (merges || commits.length !== mapped.length || commits.some((c,i)=>c!==mapped[i])) {
    throw new Error('Semantic review must map every unique commit and contain no unreviewed merges');
  }
  if (review.commitMap.some(c=>c.classification !== 'ADOPTED_AND_EXTENDED') &&
      review.knownDifferences.length === 0) {
    throw new Error('Changed or intentionally retired behavior requires explicit disposition');
  }
  return {path,checksum,review};
}
export function retirementAllowed(item, opts = {}) {
  if (!item || item.checkedOut || item.protected) return false;
  if (!item.trackingMatches || !item.objectPresent) return false;
  if (!opts.approveCurrent || !/^[0-9a-f]{40}$/.test(item.sha || '') ||
      !/^[0-9a-f]{40}$/.test(item.mainSha || '') ||
      opts.expectSha?.toLowerCase() !== item.sha ||
      opts.expectMain?.toLowerCase() !== item.mainSha) return false;
  if (item.classification === 'MERGED_IN_MAIN') return item.inMain === true;
  if (item.classification === 'PATCH_EQUIVALENT_CANDIDATE') {
    return opts.allowPatch === true && item.currentResidual?.status === 'checked';
  }
  return opts.allowSemantic === true && semanticReviewApproved(item,opts.semanticReview);
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
    '--no-renames',mergeBase,branchSha],cwd,{raw:true}).out.split('\0').filter(Boolean);
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
// Compare current trees on the branch's original affected paths. Historic
// adoption is evidence, not proof that the current target retains the behavior.
export function currentResidual(cwd, baseSha, branchSha, mergeBase) {
  if (!mergeBase) return {status:'no-common-base'};
  const paths = git(['diff-tree','--no-commit-id','-r','--name-only','-z','--no-renames',
    '--ignore-submodules=none',mergeBase,branchSha],cwd,{raw:true}).out.split('\0').filter(Boolean);
  if (paths.reduce((n,p)=>n+Buffer.byteLength(p,'utf8')+1,0)>MAX_SQUASH_PATHSPEC_BYTES) {
    return {status:'path-limit-exceeded'};
  }
  const changedPaths = paths.length ? git(['--literal-pathspecs','diff-tree','--no-commit-id','-r',
    '--name-only','-z','--no-renames','--ignore-submodules=none',branchSha,baseSha,'--',...paths],
    cwd,{raw:true}).out.split('\0').filter(Boolean) : [];
  return {status:'checked', affectedPaths:paths, changedPaths};
}
export function verifyLiveTarget(cwd, remote, name, mainSha, branchSha) {
  if (git(['rev-parse','refs/heads/main'],cwd).out !== mainSha) {
    throw new Error('Local main moved; review is stale');
  }
  const ref = 'refs/heads/' + name;
  const rows = git(['ls-remote','--heads',remote,'refs/heads/main',ref],cwd)
    .out.split(/\r?\n/).filter(Boolean).map(line=>line.split(/\s+/));
  const heads = new Map(rows.map(([sha,key])=>[key,sha]));
  if (rows.length !== 2 || heads.get('refs/heads/main') !== mainSha ||
      heads.get(ref) !== branchSha) {
    throw new Error('Live remote main or branch moved; review is stale');
  }
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
    const item = { name, sha, mainSha:baseSha, trackingMatches, objectPresent,
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
    if (item.classification === 'PATCH_EQUIVALENT_CANDIDATE') {
      item.currentResidual = currentResidual(cwd,baseSha,sha,item.mergeBase);
    }
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
export function verifyBundleRecovery(bundle, mainSha, branchSha, cwd, branchRef) {
  if (!branchRef || !branchRef.startsWith('refs/remotes/') ||
      git(['check-ref-format',branchRef],cwd,{allowFailure:true}).status !== 0) {
    throw new Error('Exact archived branch ref required');
  }
  const temp = mkdtempSync(join(dirname(bundle), '.recovery-check-'));
  try {
    const bare = join(temp, 'restored.git');
    git(['init','--bare',bare],cwd);
    git(['fetch','--no-tags',bundle,'refs/heads/main:refs/heads/main',branchRef+':'+branchRef],bare);
    if (git(['rev-parse','--verify','refs/heads/main^{commit}'],bare).out !== mainSha ||
        git(['rev-parse','--verify',branchRef+'^{commit}'],bare).out !== branchSha) {
      throw new Error('Bundle restored the wrong named main or branch ref');
    }
    git(['fsck','--full','--strict'],bare);
  } finally {
    rmSync(temp,{recursive:true,force:true,maxRetries:5,retryDelay:200});
  }
}
function retire(cwd, args, item, mainSha, wts) {
  const semantic = args.allowSemantic ? loadSemanticReview(cwd,item,args) : null;
  if (!retirementAllowed(item, {...args,semanticReview:semantic?.review})) {
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
  verifyLiveTarget(cwd,args.remote,item.name,mainSha,item.sha);
  const owner = (args.forkRepo || DEFAULT_FORK).split('/')[0];
  const prs = openPrs(cwd, owner, item.name, [
    args.forkRepo || DEFAULT_FORK, args.upstreamRepo || DEFAULT_UPSTREAM,
  ]);
  if (prs.length) throw new Error('Open pull requests protect this branch: ' + JSON.stringify(prs));
  const ref = 'refs/heads/' + item.name;
  verifyLiveTarget(cwd,args.remote,item.name,mainSha,item.sha);
  const branchRef = 'refs/remotes/' + args.remote + '/' + item.name;
  if (git(['rev-parse','--verify',branchRef],cwd).out !== item.sha) {
    throw new Error('Local tracking tip moved before bundle');
  }
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
    branchRef],cwd);
  git(['bundle','verify',bundle],cwd);
  const heads = git(['bundle','list-heads',bundle],cwd).out;
  const namedHeads = new Map(heads.split(/\r?\n/).map(line=>line.split(/\s+/)).map(([sha,name])=>[name,sha]));
  if (namedHeads.get(branchRef) !== item.sha || namedHeads.get('refs/heads/main') !== mainSha) {
    throw new Error('Bundle does not contain the expected complete branch heads');
  }
  verifyBundleRecovery(bundle, mainSha, item.sha, cwd, branchRef);
  const archivedReviewInputs = [];
  if (semantic) {
    const inputs = [{path:semantic.path,sha256:semantic.checksum},
      ...semantic.review.reviewEvidence];
    for (let i = 0; i < inputs.length; i++) {
      const e = inputs[i];
      pinnedEvidence(e.path,e.sha256);
      const dest = join(archiveDir,id + '-evidence-' + i + '.json');
      copyFileSync(e.path,dest,fsConstants.COPYFILE_EXCL);
      pinnedEvidence(dest,e.sha256);
      archivedReviewInputs.push({original:e.path,archive:dest,sha256:e.sha256});
    }
  }
  const record = { state:'PREPARED', preparedAt:new Date().toISOString(),
    main:mainSha, remote:args.remote,
    semanticReview:semantic ? {path:semantic.path,sha256:semantic.checksum,
      decision:semantic.review.decision,archivedReviewInputs} : null,
    branch:item, approval:{main:args.expectMain,branch:args.expectSha,currentSemanticsAndConsumers:true},
    bundle, bundleSha256:sha256(bundle), heads,
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
  if (sha256(bundle) !== record.bundleSha256) {
    throw new Error('Archive or remote changed before deletion');
  }
  if (semantic) {
    pinnedEvidence(semantic.path,semantic.checksum);
    for (const e of semantic.review.reviewEvidence) pinnedEvidence(e.path,e.sha256);
    for (const e of archivedReviewInputs) pinnedEvidence(e.archive,e.sha256);
  }
  verifyLiveTarget(cwd,args.remote,item.name,mainSha,item.sha);
  if (git(['rev-parse','--verify',branchRef],cwd).out !== item.sha) {
    throw new Error('Local tracking tip moved before deletion');
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
    console.log('  Retirement: --apply --retire BRANCH --expect-sha FULL_SHA --expect-main FULL_SHA --approve-current-semantics --archive-dir PATH');
    console.log('  Extra approval for proven equivalent patches: --allow-patch-equivalent');
    console.log('  Historical retirement: --allow-semantic-supersession --review-receipt ABSOLUTE_JSON_PATH --review-sha256 EXACT_SHA256');
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
