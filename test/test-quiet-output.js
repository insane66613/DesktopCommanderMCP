import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CONFIG_FIELD_DEFINITIONS } from '../dist/config-field-definitions.js';
import { compactInitialProcessOutput } from '../dist/tools/improved-process-tools.js';
import { listUiResources } from '../dist/ui/resources.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

assert.equal(compactInitialProcessOutput('', 25), '(no output)');
assert.equal(compactInitialProcessOutput('one\ntwo', 25), 'one\ntwo');

const sixtyLines = Array.from({ length: 60 }, (_, index) => `line-${index + 1}`).join('\n');
const preview = compactInitialProcessOutput(sixtyLines, 25);
const previewLines = preview.split(/\r?\n/);
assert.equal(previewLines.length, 25, 'preview must honor the configured line limit');
assert.match(preview, /lines omitted from initial preview/);
assert.equal(previewLines[0], 'line-1');
assert.equal(previewLines.at(-1), 'line-60');

assert.equal(CONFIG_FIELD_DEFINITIONS.processStartOutputLineLimit.valueType, 'number');
const resourceUris = listUiResources().map((resource) => resource.uri);
assert.ok(resourceUris.includes('ui://desktop-commander/config-editor'));

const builtServer = fs.readFileSync(path.join(repoRoot, 'dist', 'server.js'), 'utf8');
const getConfigStart = builtServer.indexOf('name: "get_config"');
const setConfigStart = builtServer.indexOf('name: "set_config_value"', getConfigStart);
assert.ok(getConfigStart >= 0 && setConfigStart > getConfigStart);
const getConfigDefinition = builtServer.slice(getConfigStart, setConfigStart);
assert.ok(!getConfigDefinition.includes('CONFIG_EDITOR_RESOURCE_URI'));
assert.ok(!getConfigDefinition.includes('openai/outputTemplate'));

const builtConfigTool = fs.readFileSync(path.join(repoRoot, 'dist', 'tools', 'config.js'), 'utf8');
assert.match(builtConfigTool, /processStartOutputLineLimit/);
assert.match(builtConfigTool, /between 5 and 500 lines/);

console.log('quiet-output regression checks passed');
