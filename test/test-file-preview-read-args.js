import assert from 'node:assert/strict';
import { pickReadArgs } from '../dist/ui/file-preview/src/read-args.js';

assert.deepEqual(pickReadArgs({
  path:'/docs/story.md',view_range:[10,20],
  origin:'ui',old_string:'do-not-forward',content:'nope',
}),{path:'/docs/story.md',view_range:[10,20]},
'preview must retain one-based view_range without forwarding mutation arguments');

assert.deepEqual(pickReadArgs({
  path:'/docs/story.md',offset:8,length:12,view_range:undefined,
  sheet:'A',range:'B2:C3',isUrl:false,
}),{path:'/docs/story.md',offset:8,length:12,sheet:'A',range:'B2:C3',isUrl:false},
'legacy partial, spreadsheet and URL parameters retain their values');

assert.deepEqual(pickReadArgs({
  file_path:'/docs/story.md',old_string:'x',new_string:'y',expected_replacements:1,
}),{path:'/docs/story.md'},'mutations convert file_path only');

assert.deepEqual(pickReadArgs({path:'/docs/story.md',view_range:[3,-1]}),
  {path:'/docs/story.md',view_range:[3,-1]},
  'end sentinel is preserved');
assert.equal(pickReadArgs({content:'hello'}),undefined,'missing path is rejected');
assert.equal(pickReadArgs(null),undefined);
assert.equal(pickReadArgs('/docs/story.md'),undefined);
console.log('PASS: preview RPC retains view_range and all supported original read args');
