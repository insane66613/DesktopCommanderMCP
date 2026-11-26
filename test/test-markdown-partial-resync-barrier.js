import assert from 'node:assert/strict';
import { createMarkdownController } from '../dist/ui/file-preview/src/markdown/controller.js';

const payload={
  fileName:'notes.md',filePath:'/tests/notes.md',fileType:'markdown',
  content:['alpha','line 1','line 2','line 3','line 4','line 5','line 6','line 7','line 8','beta','omega',''].join('\n'),
};
const draft=payload.content.replace('alpha','alpha updated').replace('beta','beta updated');
let disk=payload.content;
let editCalls=0;
let readCalls=0;
let diskReadable=false;
let truncateRead=false;
let failSecond=true;
const stored=[];
const originalWindow=globalThis.window;
const originalDocument=globalThis.document;
globalThis.window={setTimeout:globalThis.setTimeout};
globalThis.document={getElementById:()=>null,querySelector:()=>null};
let controller;
try {
  controller=createMarkdownController({
    callTool:async(name,args)=>{
      if(name==='edit_block'){
        editCalls++;
        if(failSecond && editCalls===2) throw new Error('second hunk could not apply');
        assert(disk.includes(args.old_string),
          'a retry may not replay a hunk that already succeeded against disk');
        disk=disk.replace(args.old_string,args.new_string);
        return {
          structuredContent:{filePath:payload.filePath,fileName:payload.fileName,fileType:payload.fileType},
          content:[{type:'text',text:'Successfully applied 1 edit'}],
        };
      }
      if(name==='read_file'){
        readCalls++;
        if(!diskReadable) throw new Error('disk transport unavailable');
        return {
          structuredContent:{filePath:payload.filePath,fileName:payload.fileName,fileType:payload.fileType},
          content:[{type:'text',text:truncateRead
            ? '[Reading 2 lines from start (total: 12 lines, 10 remaining)]\nalpha updated\nline 1'
            : disk}],
        };
      }
      throw new Error(`Unexpected tool ${name}`);
    },
    getAvailableDisplayModes:()=>['inline','fullscreen'],
    getCurrentDisplayMode:()=> 'inline',
    getCurrentPayload:()=>payload,
    setExpanded:()=>{},
    storePayloadOverride:next=>stored.push(next),
    rerender:()=>{},
    updateSaveStatus:()=>{},
  });
  const state=controller.getState(payload);
  state.draftContent=draft;
  state.dirty=true;
  await controller.saveDocument();
  assert.equal(editCalls,2,'two distinct edits must have been attempted');
  assert(disk.includes('alpha updated'),'first hunk reached disk');
  assert(disk.includes('beta\n'),'second hunk did not reach disk');
  assert.equal(state.dirty,true,'draft must remain editable and dirty');
  assert.equal(state.requiresDiskResync,true,
    'unverifiable partial save must latch a read-first barrier');
  const editsAfterPartial=editCalls;
  await controller.saveDocument();
  assert.equal(editCalls,editsAfterPartial,
    'when read retry fails, no further edit_block can be sent');
  assert(readCalls>=2,'saving again should attempt disk reconciliation');
  assert.equal(state.requiresDiskResync,true,'the barrier survives another failed read');
  diskReadable=true;
  truncateRead=true;
  await controller.saveDocument();
  assert.equal(editCalls,editsAfterPartial,
    'a paginated/incomplete reread cannot authorize further edits');
  assert.equal(state.requiresDiskResync,true,'a partial reread keeps the barrier');
  truncateRead=false;
  failSecond=false;
  await controller.saveDocument();
  assert.equal(disk,draft,'once disk is verified, pending draft converges');
  assert.equal(state.sourceContent,disk,'verified disk is the new saved baseline');
  assert.equal(state.dirty,false,'all intended edits persisted');
  assert.equal(state.requiresDiskResync,false,'barrier clears after successful read');
  assert.equal(editCalls,editsAfterPartial+1,
    'previously successful edit is not replayed');
  console.log('PASS: partial multi-hunk save refuses writes until disk reread succeeds');
} finally {
  controller?.clear();
  globalThis.window=originalWindow;
  globalThis.document=originalDocument;
}
