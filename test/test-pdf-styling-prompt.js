import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';
import { loadPromptsData, getPrompts } from '../dist/tools/prompts.js';

const catalog = await loadPromptsData();
const ids = catalog.prompts.map(item => item.id);
assert.equal(new Set(ids).size, ids.length, 'prompt IDs must be unique');
assert.equal(ids.filter(id => id.startsWith('onb2_')).length, 5,
  'existing five onboarding options must remain unchanged');
assert.equal(ids.filter(id => id === 'bp_pdf_styling').length, 1);
const prompt = catalog.prompts.find(item => item.id === 'bp_pdf_styling');
for (const term of ['write_pdf','pdf_options','printBackground','page-break-before']) {
  assert.ok(prompt.prompt.includes(term), 'missing PDF guidance: '+term);
}
const response = await getPrompts({action:'get_prompt',promptId:'bp_pdf_styling'});
assert.notEqual(response.isError,true,'PDF best practice must be callable');
assert.match(JSON.stringify(response), /PDF Styling Best Practices/);
const root = new URL('../', import.meta.url);
const guide = fs.readFileSync(new URL('docs/pdf-styling-best-practices.md',root),'utf8');
const readme = fs.readFileSync(new URL('README.md',root),'utf8');
assert.match(readme,/PDF Styling Best Practices.*docs\/pdf-styling-best-practices\.md/);
assert.match(guide,/rendered page images/i);

const env = createTestEnv();
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL('../dist/index.js',import.meta.url))],
  env: env.env, stderr: 'pipe',
});
const client = new Client({name:'pdf-styling-prompt-test',version:'1.0.0'},{capabilities:{}});
try {
  await client.connect(transport,{timeout:30000});
  const tools = (await client.listTools()).tools;
  assert.match(tools.find(t=>t.name==='write_pdf')?.description??'',/bp_pdf_styling/);
  assert.match(tools.find(t=>t.name==='get_prompts')?.description??'',/bp_pdf_styling/);
  console.log('PASS: PDF styling prompt catalog, retrieval, tools/list and README guide');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
}
