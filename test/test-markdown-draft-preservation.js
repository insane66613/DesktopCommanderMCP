import assert from 'node:assert/strict';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';

const meta = {fileName:'notes.md',filePath:'/test/notes.md',fileType:'markdown'};
const successfulEdit = () => ({
  content:[{type:'text',text:'Successfully applied 1 edit'}],
  structuredContent:meta,
});

function makeDeps(overrides={}) {
  return {
    callTool:async()=>{throw new Error('Unexpected tool call')},
    getAvailableDisplayModes:()=>['inline','fullscreen'],
    getCurrentDisplayMode:()=> 'inline',
    getCurrentPayload:()=>null,
    setExpanded:()=>{},storePayloadOverride:()=>{},rerender:()=>{},
    updateSaveStatus:()=>{}, ...overrides,
  };
}
const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));

async function testInFlightSavePreservesLaterEdit() {
  const payload={...meta,content:'alpha\n'};
  let disk=payload.content;
  let unblockFirst;
  let callCount=0;
  const originalDocument=globalThis.document;
  const originalWindow=globalThis.window;
  globalThis.document={getElementById:()=>null,querySelector:()=>null};
  globalThis.window={setTimeout:globalThis.setTimeout};
  let controller;
  try {
    controller=createMarkdownController(makeDeps({
      getCurrentPayload:()=>payload,
      callTool:async(name,args)=>{
        assert.equal(name,'edit_block');
        callCount++;
        if(callCount===1) await new Promise(resolve=>{unblockFirst=resolve});
        assert.equal(typeof args.old_string,'string');
        assert.equal(typeof args.new_string,'string');
        assert(disk.includes(args.old_string),'each save must edit actual latest disk baseline');
        disk=disk.replace(args.old_string,args.new_string);
        return successfulEdit();
      },
    }));
    const state=controller.getState(payload);
    state.draftContent='beta\n';
    state.dirty=true;
    const pending=controller.saveDocument();
    for(let i=0;i<15 && !unblockFirst;i++) await pause(2);
    assert.equal(typeof unblockFirst,'function','first save should be waiting');
    assert.equal(state.saving,true);
    state.draftContent='gamma\n';
    state.dirty=true;
    unblockFirst();
    await pending;
    assert.equal(disk,'beta\n','first in-flight save only persists earlier draft');
    assert.equal(state.fullDocumentContent,'beta\n','baseline should reflect first saved edit');
    assert.equal(state.draftContent,'gamma\n','later user draft must never be overwritten');
    assert.equal(state.dirty,true,'later changes stay marked dirty');
    for(let i=0;i<50 && callCount<2;i++) await pause(30);
    assert.equal(callCount,2,'newer draft must be scheduled and persisted after old save');
    assert.equal(disk,'gamma\n','newer draft eventually saved');
    assert.equal(state.dirty,false,'only final completed draft should become clean');
    console.log('PASS: pending save preserves and schedules later draft');
  } finally {
    controller?.clear();
    globalThis.document=originalDocument;
    globalThis.window=originalWindow;
  }
}

async function testPartialExpansionKeepsDirtyDraft() {
  const partial={...meta,content:'[Reading 2 lines from line 3 (total: 6 lines, 2 remaining)]\nmid1\nmid2'};
  const controller=createMarkdownController(makeDeps());
  try {
    const state=controller.getState(partial);
    state.draftContent='MID1 edited\nmid2';
    state.dirty=true;
    const before=controller.expandPartialPayload(partial,'before','top1\ntop2');
    assert.equal(before.content,'[Reading 4 lines from start (total: 6 lines, 2 remaining)]\ntop1\ntop2\nmid1\nmid2');
    assert.equal(state.sourceContent,'top1\ntop2\nmid1\nmid2');
    assert.equal(state.fullDocumentContent,state.sourceContent);
    assert.equal(state.draftContent,'top1\ntop2\nMID1 edited\nmid2');
    assert.equal(state.dirty,true);
    assert.equal(controller.getState(before),state,'new payload must not recreate workspace');
    const after=controller.expandPartialPayload(before,'after','end1\nend2');
    assert.equal(after.content,'top1\ntop2\nmid1\nmid2\nend1\nend2');
    assert.equal(state.fullDocumentContent,after.content);
    assert.equal(state.sourceContent,after.content);
    assert.equal(state.draftContent,'top1\ntop2\nMID1 edited\nmid2\nend1\nend2');
    assert.equal(state.dirty,true);
    assert.equal(controller.getState(after),state,'second expansion must preserve draft identity');
    console.log('PASS: load before/after retains dirty partial document draft');
  } finally {controller.clear()}
}
await testInFlightSavePreservesLaterEdit();
await testPartialExpansionKeepsDirtyDraft();
