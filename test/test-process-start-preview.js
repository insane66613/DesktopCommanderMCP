import assert from 'assert';
import { compactInitialProcessOutput } from '../dist/tools/improved-process-tools.js';

const source = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n');

const preview = compactInitialProcessOutput(source, 25);
const previewLines = preview.split('\n');
assert.equal(previewLines.length, 25, 'truncated preview must include its marker within the limit');
assert.equal(previewLines[0], 'line-0');
assert.equal(previewLines.at(-1), 'line-79');
assert.match(preview, /^\[56 lines omitted from initial preview; use read_process_output for retained output\]$/m);

const minimumPreview = compactInitialProcessOutput(source, 1);
assert.equal(minimumPreview.split('\n').length, 5, 'configured values below five clamp to five lines');

const shortOutput = 'first\nsecond';
assert.equal(compactInitialProcessOutput(shortOutput, 25), shortOutput);
assert.equal(compactInitialProcessOutput('   \n', 25), '(no output)');

console.log('process start preview bounds passed');
