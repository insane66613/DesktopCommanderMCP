import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { CONFIG_FIELD_DEFINITIONS } from '../dist/config-field-definitions.js';
import { configManager } from '../dist/config-manager.js';
import { handleExportProjectFile } from '../dist/handlers/filesystem-handlers.js';
import {
  DEFAULT_SENSITIVE_PROJECT_FILE_ALLOWED_PATTERNS,
  evaluateSensitiveProjectFileAccess,
  isSensitiveProjectFile,
} from '../dist/sensitive-project-file-policy.js';
import { getConfig, setConfigValue } from '../dist/tools/config.js';

async function main() {
  assert.deepEqual(
    CONFIG_FIELD_DEFINITIONS.sensitiveProjectFilePolicy.options,
    ['block', 'require_explicit_override', 'allow'],
  );
  assert.equal(
    evaluateSensitiveProjectFileAccess({ basename: '.env' }).reason,
    'override_required',
  );
  assert.equal(isSensitiveProjectFile('.env.example'), false);
  assert.equal(
    isSensitiveProjectFile('private-auth.json', ['private-*.json'], DEFAULT_SENSITIVE_PROJECT_FILE_ALLOWED_PATTERNS),
    true,
  );

  const configResult = await getConfig({ origin: 'ui' });
  const entries = configResult.structuredContent?.entries ?? [];
  const values = Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
  assert.equal(values.sensitiveProjectFilePolicy, 'require_explicit_override');
  assert.deepEqual(values.sensitiveProjectFileExtraPatterns, []);
  assert.deepEqual(values.sensitiveProjectFileAllowedPatterns, ['.env.example', '.env.sample', '.env.template']);
  assert.equal(values.sensitiveProjectFileAudit, true);

  const invalidPolicy = await setConfigValue({
    key: 'sensitiveProjectFilePolicy',
    value: 'disabled',
  });
  assert.equal(invalidPolicy.isError, true);

  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dc-sensitive-policy-'));
  const envFile = path.join(testDir, '.env');
  const exampleFile = path.join(testDir, '.env.example');
  const customSensitiveFile = path.join(testDir, 'private-auth.json');
  await fs.writeFile(envFile, 'SECRET=value\n');
  await fs.writeFile(exampleFile, 'EXAMPLE=value\n');
  await fs.writeFile(customSensitiveFile, '{"token":"example"}\n');

  try {
    const blockedByDefault = await handleExportProjectFile({ path: envFile });
    assert.equal(blockedByDefault.isError, true);

    const explicitOverride = await handleExportProjectFile({
      path: envFile,
      allowSensitiveProjectFile: true,
    });
    assert.notEqual(explicitOverride.isError, true);

    const allowedExample = await handleExportProjectFile({ path: exampleFile });
    assert.notEqual(allowedExample.isError, true);

    await configManager.setValue('sensitiveProjectFilePolicy', 'block');
    const blockedEvenWithOverride = await handleExportProjectFile({
      path: envFile,
      allowSensitiveProjectFile: true,
    });
    assert.equal(blockedEvenWithOverride.isError, true);
    assert.match(blockedEvenWithOverride.content[0].text ?? '', /policy=block/i);

    await configManager.setValue('sensitiveProjectFilePolicy', 'allow');
    const allowedByPolicy = await handleExportProjectFile({ path: envFile });
    assert.notEqual(allowedByPolicy.isError, true);

    await configManager.setValue('sensitiveProjectFilePolicy', 'require_explicit_override');
    await configManager.setValue('sensitiveProjectFileExtraPatterns', ['private-*.json']);
    const blockedByExtraPattern = await handleExportProjectFile({ path: customSensitiveFile });
    assert.equal(blockedByExtraPattern.isError, true);

    await configManager.setValue('sensitiveProjectFileAllowedPatterns', [
      '.env.example',
      '.env.sample',
      '.env.template',
      'private-auth.json',
    ]);
    const allowedByException = await handleExportProjectFile({ path: customSensitiveFile });
    assert.notEqual(allowedByException.isError, true);
  } finally {
    await fs.rm(testDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
