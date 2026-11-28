import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createTestEnv } from './helpers/test-env.js';
import { getEnvironmentInfo } from '../dist/tools/environment.js';

const sample = getEnvironmentInfo();
assert.ok(sample.system.cpuCount > 0);
assert.ok(sample.system.totalMemoryBytes > 0);
assert.ok(sample.process.pid > 0);
assert.equal('networkInterfaces' in sample, false);
assert.equal('env' in sample, false);
const expanded = getEnvironmentInfo({includeNetwork:true});
assert.ok(Array.isArray(expanded.networkInterfaces));

const env = createTestEnv();
env.env.DESKCOMMAND_TEST_SECRET = 'NEVER_DISCLOSE_ENV_SECRET_20261128';
const serverFile = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const transport = new StdioClientTransport({
  command: process.execPath, args:[serverFile], env:env.env, stderr:'pipe'
});
const client = new Client({name:'environment-info-test',version:'1.0.0'}, {capabilities:{}});
try {
  await client.connect(transport,{timeout:30000});
  const listed = (await client.listTools()).tools;
  const tool = listed.find(item => item.name === 'get_environment_info');
  assert.ok(tool,'new environment tool must be discoverable via tools/list');
  const result = await client.callTool({name:'get_environment_info',arguments:{}});
  assert.equal(result.isError,undefined,'environment tool should succeed');
  const text = result.content.find(item => item.type === 'text')?.text ?? '';
  assert.doesNotMatch(text,/NEVER_DISCLOSE_ENV_SECRET_20261128/);
  const parsed = JSON.parse(text);
  assert.ok(parsed.process.pid > 0);
  assert.ok(parsed.system.cpuCount > 0);
  assert.equal('networkInterfaces' in parsed,false);
  const withNet = await client.callTool({name:'get_environment_info',
    arguments:{includeNetwork:true}});
  assert.equal(withNet.isError,undefined);
  assert.ok(Array.isArray(JSON.parse(withNet.content[0].text).networkInterfaces));
  console.log('PASS: environment tool MCP discovery, runtime data, optional network and redaction');
} finally {
  await client.close().catch(()=>{});
  env.cleanup();
}
