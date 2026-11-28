import assert from 'node:assert/strict';
import { inferMutationTool, pickReadArgs } from '../dist/ui/file-preview/src/read-args.js';

const excelEdit = {
  file_path:'C:\\reports\\data.xlsx', range:'Revenue!C12:C12', content:[[42]],
};
const textEdit = {
  file_path:'C:\\notes.md',old_string:'before',new_string:'',
};
const write = {path:'C:\\reports\\data.xlsx',content:[[42]]};
const read = {path:'C:\\reports\\data.xlsx',sheet:'Revenue',range:'A1:B10'};

assert.equal(inferMutationTool(excelEdit),'edit_block',
  'range/content Excel edits must refresh after the edit succeeds');
assert.equal(inferMutationTool(textEdit),'edit_block',
  'empty new_string is a valid editing operation');
assert.equal(inferMutationTool(write),'write_file');
assert.equal(inferMutationTool(read),undefined,
  'ordinary Excel read with a range must pull at input time');
assert.equal(inferMutationTool(null),undefined);
assert.equal(inferMutationTool({}),undefined);

const picked=pickReadArgs(excelEdit);
assert.deepEqual(picked,{path:excelEdit.file_path,range:excelEdit.range},
  'Excel edit source must become a valid read_file request, without content');
assert.equal(Boolean(picked && !inferMutationTool(excelEdit)),false,
  'Excel edit preview cannot pull before mutation completes');
assert.equal(Boolean(pickReadArgs(read) && !inferMutationTool(read)),true);
console.log('PASS: Excel edit_block refresh timing, source attribution and read args');
