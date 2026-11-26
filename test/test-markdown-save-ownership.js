import assert from 'node:assert/strict';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';

const fileA={filePath:'/tests/alpha.md',fileName:'alpha.md',fileType:'markdown',content:'old A\n'};
const fileB={filePath:'/tests/beta.md',fileName:'beta.md',fileType:'markdown',content:'old B\n'};
const successfulEdit={
  structuredContent:{filePath:fileA.filePath,fileName:fileA.fileName,fileType:fileA.fileType},
  content:[{type:'text',text:'Successfully applied one edit'}],
};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function verifyLateSaveDoesNotOwnNewWorkspace({fail=false}={}) {
  const savedStatuses=[];
  const overrides=[];
  const renders=[];
  let current=fileA;
  let resolveFirst;
  let editCalls=0;
  let reloads=0;
  const originalDocument=globalThis.document;
  const originalWindow=globalThis.window;
  globalThis.document={getElementById:()=>null,querySelector:()=>null};
  globalThis.window={setTimeout:globalThis.setTimeout};
  let controller;
  try {
    controller=createMarkdownController({
      callTool:async(name,args)=>{
        if(name==='edit_block') {
          editCalls++;
          assert.equal(args.file_path,fileA.filePath,'the old request must retain its file path');
          await new Promise(resolve=>{resolveFirst=resolve});
          if(fail) throw new Error('Remote edit failed');
          return successfulEdit;
        }
        if(name==='read_file') {
          reloads++;
          return {
            structuredContent:{filePath:fileA.filePath,fileName:fileA.fileName,fileType:fileA.fileType},
            content:[{type:'text',text:fileA.content}],
          };
        }
        throw new Error(`Unexpected ${name}`);
      },
      getCurrentPayload:()=>current,
      getAvailableDisplayModes:()=>['inline','fullscreen'],
      getCurrentDisplayMode:()=> 'inline',
      setExpanded:()=>{},
      storePayloadOverride:payload=>overrides.push(payload),
      rerender:()=>renders.push(current.filePath),
      updateSaveStatus:(label,status)=>savedStatuses.push({label,status,file:current.filePath}),
      trackUiEvent:()=>{},
    });
    const a=controller.getState(fileA);
    a.draftContent='new A\n';
    a.dirty=true;
    const pending=controller.saveDocument();
    for(let i=0;i<20&&!resolveFirst;i++) await pause(2);
    assert.equal(typeof resolveFirst,'function','save must be in flight');
    current=fileB;
    const b=controller.getState(fileB);
    b.draftContent='new B\n';
    b.dirty=true;
    resolveFirst();
    await pending;
    assert.equal(b.draftContent,'new B\n','late A callback must not erase B edits');
    assert.equal(b.fullDocumentContent,'old B\n','late A callback must not update B baseline');
    assert.equal(b.dirty,true,'B unsaved status preserved');
    assert.equal(overrides.length,0,'late A callback cannot publish old content to B widget');
    assert.deepEqual(savedStatuses,[],'late A save cannot update B status');
    assert.deepEqual(renders,[],'late A failure cannot rerender B');
    await pause(1150);
    assert.equal(editCalls,1,'old autosave timer cannot fire on new B workspace');
    assert.equal(reloads,0,'stale failing save need not fetch discarded A workspace');
    console.log(`PASS: ${fail?'failed':'successful'} late A save leaves B workspace untouched`);
  } finally {
    controller?.clear();
    globalThis.document=originalDocument;
    globalThis.window=originalWindow;
  }
}
await verifyLateSaveDoesNotOwnNewWorkspace();
await verifyLateSaveDoesNotOwnNewWorkspace({fail:true});
