/** An audited merge conflict must be pinned, not waived for historical retirement. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadSemanticReview, semanticReviewApproved } from '../scripts/reconcile-branches.mjs';

function cmd(cwd, args, exitCode = 0) {
  const result = spawnSync('git', args, { cwd, encoding:'utf8', windowsHide:true });
  assert.equal(result.status, exitCode, args.join(' ') + ': ' + result.stderr);
  return result.stdout;
}
const dir = mkdtempSync(join(tmpdir(),'dc-semantic-merge-review-'));
try {
  const repo = join(dir,'repo');
  mkdirSync(repo);
  cmd(repo,['init','-b','main']);
  cmd(repo,['config','user.email','fixture@example.invalid']);
  cmd(repo,['config','user.name','Fixture']);
  cmd(repo,['config','core.autocrlf','false']);
  mkdirSync(join(repo,'src'));
  const source=join(repo,'src','search.js');
  writeFileSync(source,'export const search = "baseline";\n');
  cmd(repo,['add','src/search.js']);
  cmd(repo,['commit','-m','base']);
  const base=cmd(repo,['rev-parse','HEAD']).trim();
  cmd(repo,['switch','-c','old']);
  writeFileSync(source,'export const search = "historical";\n');
  cmd(repo,['commit','-am','historical source change']);
  const unique=cmd(repo,['rev-parse','HEAD']).trim();
  // An independent historical feature reachable through the merge must never
  // disappear from commitMap merely because remerge-diff shows one conflict.
  writeFileSync(join(repo,'historical-helper.txt'),'independent historical side effect\n');
  cmd(repo,['add','historical-helper.txt']);
  cmd(repo,['commit','-m','another historical feature with no conflict']);
  const additionalUnique=cmd(repo,['rev-parse','HEAD']).trim();
  cmd(repo,['switch','main']);
  writeFileSync(source,'export const search = "upstream";\n');
  cmd(repo,['commit','-am','new upstream']);
  const main=cmd(repo,['rev-parse','HEAD']).trim();
  cmd(repo,['switch','old']);
  cmd(repo,['merge','main'],1);
  writeFileSync(source,'export const search = "upstream+historical";\n');
  cmd(repo,['add','src/search.js']);
  cmd(repo,['commit','-m','resolve explicit conflict']);
  const merge=cmd(repo,['rev-parse','HEAD']).trim();
  const parents=cmd(repo,['rev-list','--parents','-n','1',merge]).trim().split(/\s+/).slice(1);
  assert.deepEqual(parents,[additionalUnique,main]);
  const rem=cmd(repo,['show','--remerge-diff','--format=','--no-ext-diff',merge]);
  const diffHash=createHash('sha256').update(rem).digest('hex').toUpperCase();
  const resolutionPaths=cmd(repo,['show','--remerge-diff','--format=','--name-only',merge]).trim().split(/\r?\n/);
  assert.deepEqual(resolutionPaths,['src/search.js']);
  const gitVersion=cmd(repo,['--version']).trim();
  const parentDiffPathSha256=parents.map(parent => createHash('sha256')
    .update(cmd(repo,['diff','--name-only','-z','--no-renames',parent,merge]))
    .digest('hex').toUpperCase());
  const mainBlobOid=cmd(repo,['rev-parse',main+':src/search.js']).trim();
  const evidence=[];
  for (let i=0;i<2;i++) {
    const path=join(dir,'review-'+i+'.json');
    const content=JSON.stringify({review:i,base,main,merge});
    writeFileSync(path,content);
    evidence.push({kind:'independent-review',sourceId:'fixture-'+i,path,
      sha256:createHash('sha256').update(content).digest('hex').toUpperCase()});
  }
  const item={name:'old',sha:merge,mainSha:main,classification:'UNIQUE_REVIEW',
    uniqueMerges:1,uniquePatches:2};
  const approval={
    schemaVersion:1,decision:'APPROVED_SEMANTICALLY_SUPERSEDED',
    branch:'old',branchSha:merge,mainSha:main,unresolvedFeatureGaps:0,
    ownerApproval:{authorization:'OWNER_DIRECTIVE_BRANCH_RETIREMENT',
      sourceInstruction:'Synthetic explicit test owner approval'},
    consumerAudit:{status:'NO_ACTIVE_CONSUMERS',
      scopes:['repository','automation','deployment']},
    commitMap:[{sha:unique,classification:'ADOPTED_AND_EXTENDED',
      current:'Reviewed current synthesized source path',
      sourcePath:'src/search.js',testEvidence:'Synthetic source matches test'},
      {sha:additionalUnique,classification:'ADOPTED_AND_EXTENDED',
      current:'Reviewed additional unique branch-side inherited commit',
      sourcePath:'src/search.js',testEvidence:'Synthetic inherited commit is covered'}],
    mergeMap:[{sha:merge,parents,remergeDiffSha256:diffHash,resolutionPaths,
      gitVersion,parentDiffPathSha256,mainParentIndex:1,
      fileDispositions:[{path:'src/search.js',mainBlobOid,
        classification:'ADOPTED_AND_EXTENDED',ownerApproved:true,
        current:'Reviewed replacement source blob on current main',
        testEvidence:'Synthetic source merge resolution parity tested'}],
      classification:'ADOPTED_AND_EXTENDED',ownerApproved:true,
      current:'Reviewed exact merged conflict resolution and current equivalent',
      testEvidence:'Synthetic source merge resolution parity tested'}],
    reviewEvidence:evidence,knownDifferences:[],
  };
  const path=join(dir,'approval.json');
  const argsFor=(receipt)=>{
    const bytes=JSON.stringify(receipt);
    writeFileSync(path,bytes);
    return {reviewReceipt:path,reviewSha256:createHash('sha256').update(bytes).digest('hex').toUpperCase()};
  };
  assert.equal(semanticReviewApproved(item,approval),true);
  assert.equal(loadSemanticReview(repo,item,argsFor(approval)).review.mergeMap[0].sha,merge);
  for (const [label,change,pattern] of [
    ['missing merge review',a=>delete a.mergeMap,/incomplete or stale/],
    ['omitted inherited commit',a=>a.commitMap.pop(),/map every unique commit/],
    ['wrong merge SHA',a=>a.mergeMap[0].sha='f'.repeat(40),/map every unique merge/],
    ['wrong parent',a=>a.mergeMap[0].parents[0]=base,/merge parent identity/],
    ['wrong main-parent index',a=>a.mergeMap[0].mainParentIndex=0,/main-parent lineage/],
    ['wrong SHA256',a=>a.mergeMap[0].remergeDiffSha256='f'.repeat(64),/diff SHA256 mismatch/],
    ['wrong Git version',a=>a.mergeMap[0].gitVersion='git version 0.0.0',/Git version differs/],
    ['wrong parent inventory',a=>a.mergeMap[0].parentDiffPathSha256[0]='f'.repeat(64),/parent\/result path inventory/],
    ['wrong source blob',a=>a.mergeMap[0].fileDispositions[0].mainBlobOid='f'.repeat(40),/successor source blob changed/],
    ['missing file disposition',a=>a.mergeMap[0].fileDispositions=[],/incomplete or stale/],
    ['wrong path',a=>a.mergeMap[0].resolutionPaths=['src/other.js'],/incomplete or stale/],
    ['unreviewed extra merge entry',a=>a.mergeMap.push({...a.mergeMap[0]}),/incomplete or stale/],
    ['traversal',a=>a.mergeMap[0].resolutionPaths=['../outside.js'],/incomplete or stale/],
    ['windows drive path',a=>a.mergeMap[0].resolutionPaths=['C:outside.js'],/incomplete or stale/],
    ['third merge parent',a=>a.mergeMap[0].parents.push(base),/incomplete or stale/],
    ['missing source',a=>a.commitMap[0].sourcePath='src/missing.js',/successor file missing/],
  ]) {
    const cloned=structuredClone(approval);
    change(cloned);
    assert.throws(()=>loadSemanticReview(repo,item,argsFor(cloned)),pattern,label);
  }
  const missingMerges={...approval,mergeMap:[]};
  assert.equal(semanticReviewApproved(item,missingMerges),false);
  console.log('PASS merge-review guard: exact parent/order, remerge diff SHA256, paths, commits, evidence and fail-closed bad attestations');
} finally {
  rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}

