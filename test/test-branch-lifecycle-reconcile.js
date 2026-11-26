import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyBranch, retirementAllowed, verifyBundleRecovery, summarizeHotspots, verifyLiveTarget } from '../scripts/reconcile-branches.mjs';

const cli = resolve(fileURLToPath(new URL('../scripts/reconcile-branches.mjs', import.meta.url)));
function run(command, args, cwd, expected = 0) {
  const r = spawnSync(command, args, { cwd, encoding:'utf8',
    windowsHide:true, maxBuffer:8*1024*1024 });
  assert.equal(r.status, expected,
    command + ' ' + args.join(' ') + '\n' + (r.stderr || r.stdout));
  return (r.stdout || '').trim();
}
function git(cwd, ...args) { return run('git',args,cwd); }
assert.deepEqual(summarizeHotspots([
  { name:'a', changedPaths:['src/a.ts','src/b.ts'] },
  { name:'b', changedPaths:['src/b.ts'] },
  { name:'c', changedPaths:['src/a.ts','src/b.ts'] },
]), [
  {path:'src/b.ts',branchCount:3,branches:['a','b','c']},
  {path:'src/a.ts',branchCount:2,branches:['a','c']},
], 'hotspot ranking must be descriptive, deterministic and not imply equivalence');
assert.equal(classifyBranch({protected:true}), 'PROTECTED');
assert.equal(classifyBranch({checkedOut:true}), 'PROTECTED');
assert.equal(classifyBranch({trackingMatches:false}), 'UNFETCHED_OR_MOVED');
assert.equal(classifyBranch({objectPresent:false}), 'UNFETCHED_OR_MOVED');
assert.equal(classifyBranch({objectPresent:true,trackingMatches:true,
  inMain:true}), 'MERGED_IN_MAIN');
assert.equal(classifyBranch({objectPresent:true,trackingMatches:true,
  uniquePatches:0,uniqueMerges:0}), 'PATCH_EQUIVALENT_CANDIDATE');
assert.equal(classifyBranch({objectPresent:true,trackingMatches:true,
  uniquePatches:2,uniqueMerges:0,squashEquivalentCommit:'a'.repeat(40)}),
  'PATCH_EQUIVALENT_CANDIDATE');
assert.equal(classifyBranch({objectPresent:true,trackingMatches:true,
  uniquePatches:1,uniqueMerges:0}), 'UNIQUE_REVIEW');
assert.equal(classifyBranch({objectPresent:true,trackingMatches:true,
  uniquePatches:0,uniqueMerges:1}), 'UNIQUE_REVIEW');
assert.equal(retirementAllowed({classification:'UNIQUE_REVIEW',
  objectPresent:true,trackingMatches:true}),false);
assert.equal(retirementAllowed({classification:'PATCH_EQUIVALENT_CANDIDATE',
  objectPresent:true,trackingMatches:true}),false);
assert.equal(retirementAllowed({classification:'PATCH_EQUIVALENT_CANDIDATE',
  objectPresent:true,trackingMatches:true},{allowPatch:true}),false);
assert.equal(retirementAllowed({classification:'MERGED_IN_MAIN',
  objectPresent:true,trackingMatches:true,checkedOut:true}),false);
const dir = mkdtempSync(join(tmpdir(),'deskcommand-branch-reconcile-'));
const remote = join(dir,'remote.git');
const repo = join(dir,'repo');
try {
  mkdirSync(repo);
  git(dir,'init','--bare',remote);
  git(dir,'init','-b','main',repo);
  git(repo,'config','user.name','Test');
  git(repo,'config','user.email','test@example.invalid');
  writeFileSync(join(repo,'base.txt'),'base\n');
  git(repo,'add','base.txt');
  git(repo,'commit','-m','base');
  const base = git(repo,'rev-parse','HEAD');
  git(repo,'remote','add','fork',remote);
  git(repo,'push','-u','fork','main');
  git(repo,'switch','-c','merged');
  writeFileSync(join(repo,'feature.txt'),'existing feature\n');
  git(repo,'add','feature.txt');
  git(repo,'commit','-m','feature on branch');
  git(repo,'push','fork','merged');
  git(repo,'switch','main');
  git(repo,'merge','--no-ff','merged','-m','integrate feature');
  git(repo,'push','fork','main');
  git(repo,'switch','-c','squashed',base);
  writeFileSync(join(repo,'squash-a.txt'),'squash A\n');
  git(repo,'add','squash-a.txt');
  git(repo,'commit','-m','squash source part one');
  writeFileSync(join(repo,'squash-b.txt'),'squash B\n');
  git(repo,'add','squash-b.txt');
  git(repo,'commit','-m','squash source part two');
  git(repo,'push','fork','squashed');
  git(repo,'switch','main');
  git(repo,'merge','--squash','squashed');
  git(repo,'commit','-m','squash adoption');
  const squashAdoptionSha = git(repo,'rev-parse','HEAD');
  git(repo,'push','fork','main');
  git(repo,'switch','-c','near-squash',base);
  writeFileSync(join(repo,'squash-a.txt'),'squash A\n');
  git(repo,'add','squash-a.txt');
  git(repo,'commit','-m','near squash part one');
  writeFileSync(join(repo,'squash-b.txt'),'squash B changed\n');
  git(repo,'add','squash-b.txt');
  git(repo,'commit','-m','near squash part two');
  git(repo,'push','fork','near-squash');
  git(repo,'switch','main');
  git(repo,'switch','-c','equivalent',base);
  writeFileSync(join(repo,'feature.txt'),'existing feature\n');
  git(repo,'add','feature.txt');
  git(repo,'commit','-m','duplicate patch');
  git(repo,'push','fork','equivalent');
  git(repo,'switch','main');
  git(repo,'switch','-c','unique');
  writeFileSync(join(repo,'unique.txt'),'not yet integrated\n');
  git(repo,'add','unique.txt');
  git(repo,'commit','-m','unique work');
  git(repo,'push','fork','unique');
  git(repo,'switch','main');
  git(repo,'push','fork','HEAD:refs/heads/codex/protected');
  git(repo,'fetch','fork','+refs/heads/*:refs/remotes/fork/*');
  const audit = JSON.parse(run(process.execPath,[cli,'--remote','fork','--json'],repo));
  assert.equal(audit.worktrees.length,1);
  const hotspotAudit = JSON.parse(run(process.execPath,
    [cli,'--remote','fork','--hotspots','--json'],repo));
  assert.equal(hotspotAudit.hotspotScope.reviewedBranches,2,
    'only non-equivalent unique patch branches need changed-file sampling');
  assert(hotspotAudit.branches.find(x => x.name === 'unique').changedPaths.includes('unique.txt'));
  assert.match(hotspotAudit.hotspotScope.disclaimer,/not duplicate code/);
  assert.equal(audit.branches.length,7);
  const byName = Object.fromEntries(audit.branches.map(x => [x.name,x]));
  assert.equal(byName.main.classification,'PROTECTED');
  assert.equal(byName.merged.classification,'MERGED_IN_MAIN');
  assert.equal(byName.equivalent.classification,'PATCH_EQUIVALENT_CANDIDATE');
  assert.equal(byName.squashed.classification,'PATCH_EQUIVALENT_CANDIDATE',
    'multi-commit work adopted by an exact squash must not be misclassified as unique');
  assert.equal(byName.squashed.squashEquivalentCommit,squashAdoptionSha);
  assert.equal(byName.squashed.squashCheck,'exact-match');
  assert.equal(byName.squashed.uniquePatches,2);
  const approve = item => ({allowPatch:true, approveCurrent:true,
    expectSha:item.sha, expectMain:item.mainSha});
  assert.deepEqual(byName.squashed.currentResidual,
    {status:'checked', affectedPaths:['squash-a.txt','squash-b.txt'], changedPaths:[]});
  assert.equal(retirementAllowed(byName.squashed,{allowPatch:true}),false);
  assert.equal(retirementAllowed(byName.squashed,approve(byName.squashed)),true);
  assert.equal(retirementAllowed(byName.merged,approve(byName.merged)),true);
  assert.equal(retirementAllowed(byName.merged,{}),false);
  assert.equal(retirementAllowed(byName['codex/protected'],approve(byName['codex/protected'])),false);
  assert.equal(retirementAllowed({...byName.squashed,currentResidual:{status:'path-limit-exceeded'}},
    approve(byName.squashed)),false);
  assert.equal(byName['near-squash'].classification,'UNIQUE_REVIEW',
    'a one-blob near-match must remain unique');
  assert.equal(byName['near-squash'].squashEquivalentCommit,null);
  assert.equal(byName['near-squash'].squashCheck,'no-match');
  assert.equal(byName.unique.classification,'UNIQUE_REVIEW');
  assert.equal(byName['codex/protected'].classification,'PROTECTED');
  assert.deepEqual(audit.summary,{
    PROTECTED:2,MERGED_IN_MAIN:1,PATCH_EQUIVALENT_CANDIDATE:2,UNIQUE_REVIEW:2,
  });
  const attached = join(dir,'attached-worktree');
  git(repo,'worktree','add',attached,'unique');
  const withCheckout = JSON.parse(run(process.execPath,[cli,'--remote','fork','--json'],repo));
  assert.equal(withCheckout.worktrees.length,2);
  assert.equal(withCheckout.branches.find(x => x.name === 'unique').classification,
    'PROTECTED','checked-out remote branch is never an auto-retirement candidate');
  assert.equal(retirementAllowed(withCheckout.branches.find(x => x.name === 'unique'),
    approve(withCheckout.branches.find(x => x.name === 'unique'))),false);
  git(repo,'worktree','remove',attached);
  assert.doesNotThrow(()=>verifyLiveTarget(repo,'fork','squashed',audit.main,byName.squashed.sha));
  const unique = byName.unique.sha;
  const archive = join(dir,'archive');
  mkdirSync(archive);
  const bundle = join(archive,'restore-check.bundle');
  git(repo,'bundle','create',bundle,'refs/heads/main','refs/remotes/fork/merged');
  const mainSha = git(repo,'rev-parse','refs/heads/main');
  const mergedRef = 'refs/remotes/fork/merged';
  assert.doesNotThrow(() => verifyBundleRecovery(bundle,mainSha,byName.merged.sha,repo,mergedRef));
  assert.throws(() => verifyBundleRecovery(bundle,mainSha,unique,repo,mergedRef),
    /wrong named/, 'archive containing the wrong branch tip must fail recovery proof');
  assert.throws(() => verifyBundleRecovery(bundle,mainSha,byName.merged.sha,repo,'refs/remotes/fork/squashed'),
    /couldn't find remote ref|git fetch/, 'object presence is insufficient without exact named ref');
  // The expected object is already present as an ancestor of main, but the
  // named archived branch points elsewhere. This was accepted by the old check.
  assert.throws(()=>verifyBundleRecovery(bundle,mainSha,base,repo,mergedRef),/wrong named/);
  const fail = spawnSync(process.execPath,[cli,'--remote','fork','--retire','unique',
    '--apply','--archive-dir',archive,'--expect-sha',unique,'--expect-main',mainSha,'--approve-current-semantics'],
    {cwd:repo,encoding:'utf8'});
  assert.notEqual(fail.status,0,'unique unmerged branch must not be deleted');
  assert.match(fail.stderr,/not an eligible/);
  assert.equal(git(repo,'ls-remote','fork','refs/heads/unique').split(/\s+/)[0],unique);
  const noApply = spawnSync(process.execPath,[cli,'--remote','fork','--retire','merged'],
    {cwd:repo,encoding:'utf8'});
  assert.notEqual(noApply.status,0,'retirement must require --apply');
  assert.match(noApply.stderr,/requires --apply/);
  // Reproduce Wave 5: historical squash match survives a revert, while
  // current affected paths no longer match. No historical boolean authorizes it.
  git(repo,'revert','--no-edit',squashAdoptionSha);
  const revertedMain = git(repo,'rev-parse','HEAD');
  assert.throws(()=>verifyLiveTarget(repo,'fork','squashed',mainSha,byName.squashed.sha),/Local main moved/);
  assert.throws(()=>verifyLiveTarget(repo,'fork','squashed',revertedMain,byName.squashed.sha),/Live remote main or branch moved/);
  git(repo,'push','fork','main');
  const reverted = JSON.parse(run(process.execPath,[cli,'--remote','fork','--json'],repo))
    .branches.find(b=>b.name==='squashed');
  assert.equal(reverted.squashEquivalentCommit,squashAdoptionSha);
  assert.equal(reverted.classification,'PATCH_EQUIVALENT_CANDIDATE');
  assert.deepEqual(reverted.currentResidual.changedPaths,['squash-a.txt','squash-b.txt']);
  assert.equal(spawnSync('git',['cat-file','-e','HEAD:squash-a.txt'],{cwd:repo}).status,128);
  assert.equal(retirementAllowed(reverted,{allowPatch:true}),false);
  assert.equal(retirementAllowed(reverted,approve(byName.squashed)),false,'old main approval must fail');
  assert.equal(retirementAllowed(reverted,approve(reverted)),true,'exact explicit current review is required');
  assert.equal(retirementAllowed({...reverted,sha:unique},approve(reverted)),false,'changed branch invalidates approval');
  // A moved remote branch is detected even when local tracking remains stale.
  git(repo,'switch','equivalent');
  writeFileSync(join(repo,'new-residual.txt'),'new branch change\n');
  git(repo,'add','new-residual.txt');
  git(repo,'commit','-m','advance branch');
  git(repo,'push','fork','equivalent');
  git(repo,'switch','main');
  assert.throws(()=>verifyLiveTarget(repo,'fork','equivalent',revertedMain,byName.equivalent.sha),
    /Live remote main or branch moved/);
  const stale = spawnSync(process.execPath,[cli,'--remote','fork','--retire','squashed',
    '--apply','--allow-patch-equivalent','--archive-dir',archive,'--expect-sha',reverted.sha,
    '--expect-main',mainSha,'--approve-current-semantics'],{cwd:repo,encoding:'utf8'});
  assert.notEqual(stale.status,0);
  assert.match(stale.stderr,/not an eligible/);
  const noApproval = spawnSync(process.execPath,[cli,'--remote','fork','--retire','squashed',
    '--apply','--allow-patch-equivalent','--archive-dir',archive,'--expect-sha',reverted.sha,
    '--expect-main',revertedMain],{cwd:repo,encoding:'utf8'});
  assert.notEqual(noApproval.status,0);
  assert.match(noApproval.stderr,/approve-current-semantics/);
  assert.equal(git(repo,'ls-remote','fork','refs/heads/squashed').split(/\s+/)[0],reverted.sha);
  console.log('PASS: current residuals, stale approvals/live refs, named restore, protected and checked-out guards; no branch deletes');
} finally {
  rmSync(dir,{recursive:true,force:true,maxRetries:5,retryDelay:250});
}
