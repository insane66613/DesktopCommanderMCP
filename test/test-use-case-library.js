import assert from 'node:assert/strict';
import fs from 'node:fs';
const readme = fs.readFileSync('README.md','utf8');
const guide = fs.readFileSync('docs/use-case-library.md','utf8');
const schemas = fs.readFileSync('src/tools/schemas.ts','utf8');

assert.match(readme,/\[Use Case Library\]\(docs\/use-case-library\.md\)/);
const names = [...guide.matchAll(/\*\*Tools:\*\* ([^\n]+)/g)]
  .flatMap(match => [...match[1].matchAll(/`([a-z_]+)`/g)].map(x => x[1]));
assert.equal(names.length > 12,true,'guide must cover concrete MCP workflows');
for(const name of new Set(names)) {
  assert.ok(schemas.includes('  '+name+':'), 'tool not registered: '+name);
}
for(const heading of ['codebase','spreadsheet','running development service','Word document','PDF']) {
  assert.ok(guide.toLowerCase().includes(heading.toLowerCase()),heading);
}
assert.doesNotMatch(guide,/desktopcommander\.app\/use-cases\.html/);
console.log('PASS: portable use-case guide, README link and current MCP tool names');
