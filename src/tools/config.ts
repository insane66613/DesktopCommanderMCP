import { configManager, ServerConfig } from '../config-manager.js';
import { GetConfigArgsSchema, SetConfigValueArgsSchema } from './schemas.js';
import { getSystemInfo } from '../utils/system-info.js';
import { currentClient } from '../server.js';
import { featureFlagManager } from '../utils/feature-flags.js';
import { getDedupCounters } from '../utils/request-dedup.js';
import { access, readFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import {
  CONFIG_FIELD_DEFINITIONS,
  CONFIG_FIELD_KEYS,
  isConfigFieldKey,
} from '../config-field-definitions.js';

const SENSITIVE_CONFIG_FIELD_DEFINITIONS = {
  sensitiveProjectFilePolicy: {
    label: 'Sensitive Project File Policy',
    description: 'Controls export_project_file when a filename matches a protected credential/secret pattern.',
    valueType: 'string' as const,
    options: ['block', 'require_explicit_override', 'allow'] as const,
  },
  sensitiveProjectFileExtraPatterns: {
    label: 'Extra Sensitive File Patterns',
    description: 'Additional filename patterns treated as sensitive by export_project_file.',
    valueType: 'array' as const,
  },
  sensitiveProjectFileAllowedPatterns: {
    label: 'Sensitive File Exceptions',
    description: 'Filename patterns explicitly treated as safe even when they match a built-in or extra sensitive pattern.',
    valueType: 'array' as const,
  },
  sensitiveProjectFileAudit: {
    label: 'Sensitive File Audit Log',
    description: 'Log blocked sensitive export attempts and successful explicit overrides without logging file contents.',
    valueType: 'boolean' as const,
  },
};

const ALL_CONFIG_FIELD_DEFINITIONS: Record<string, { valueType: string; options?: readonly string[] }> = {
  ...CONFIG_FIELD_DEFINITIONS,
  ...SENSITIVE_CONFIG_FIELD_DEFINITIONS,
};

const ALLOWED_CONFIG_KEYS = new Set<string>([
  ...CONFIG_FIELD_KEYS,
  ...Object.keys(SENSITIVE_CONFIG_FIELD_DEFINITIONS),
]);

async function pathExists(pathValue: string): Promise<boolean> {
  try {
    await access(pathValue, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function detectAvailableShells(systemInfo: ReturnType<typeof getSystemInfo>): Promise<string[]> {
  const detected = new Set<string>();
  const add = (shell: string): void => {
    if (shell.trim().length > 0) {
      detected.add(shell.trim());
    }
  };

  add(systemInfo.defaultShell);

  if (systemInfo.isWindows) {
    add(process.env.ComSpec ?? '');
    const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
    const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
    const candidates = [
      `${programFiles}\\PowerShell\\7\\pwsh.exe`,
      `${systemRoot}\\System32\\cmd.exe`,
      `${systemRoot}\\System32\\bash.exe`,
      'pwsh.exe',
      'cmd.exe',
      'bash.exe',
    ];

    for (const shell of candidates) {
      if (shell.includes('\\')) {
        if (await pathExists(shell)) {
          add(shell);
        }
      } else {
        add(shell);
      }
    }

    return [...detected];
  }

  add(process.env.SHELL ?? '');

  const shellFiles = ['/etc/shells'];
  for (const shellFile of shellFiles) {
    try {
      const content = await readFile(shellFile, 'utf8');
      content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .forEach(add);
    } catch {
      // Best-effort discovery only.
    }
  }

  const fallbackCandidates = ['/bin/zsh', '/bin/bash', '/bin/sh', '/usr/bin/fish'];
  for (const shell of fallbackCandidates) {
    if (await pathExists(shell)) {
      add(shell);
    }
  }

  return [...detected];
}

/**
 * Get configuration. Defaults to a bounded compact representation. Large values
 * are explicitly omitted with a request for verbose mode, never reported as empty.
 * containing essential configuration fields and entries without verbose system telemetry.
 * When verbose === true or origin === 'ui', returns the full comprehensive diagnostic
 * and schema payload.
 */
export async function getConfig(args?: unknown) {
  try {
    const parsed = GetConfigArgsSchema.safeParse(args ?? {});
    if (!parsed.success) {
      return {
        content: [{ type: 'text' as const, text: 'Invalid get_config arguments.' }],
        isError: true,
      };
    }
    const isVerbose = (
      parsed.data.verbose === true ||
      parsed.data.origin === 'ui' ||
      parsed.data.compact === false
    );

    const config = await configManager.getConfig();
    const systemInfo = getSystemInfo();

    if (isVerbose) {
      // Add system information and current client to the verbose config response
      const memoryUsage = process.memoryUsage();
      const memory = {
        rss: `${(memoryUsage.rss / 1024 / 1024).toFixed(2)} MB`,
        heapTotal: `${(memoryUsage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
        heapUsed: `${(memoryUsage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
        external: `${(memoryUsage.external / 1024 / 1024).toFixed(2)} MB`,
        arrayBuffers: `${(memoryUsage.arrayBuffers / 1024 / 1024).toFixed(2)} MB`
      };

      const configWithSystemInfo = {
        ...config,
        currentClient,
        featureFlags: featureFlagManager.getAll(),
        systemInfo: {
          ...systemInfo,
          memory
        },
        _metrics: {
          dedup: getDedupCounters(),
        },
      };
      const availableShells = await detectAvailableShells(systemInfo);

      const entries: Array<{ key: string; value: unknown; valueType: string; editable: boolean }> = CONFIG_FIELD_KEYS.map((key) => {
        const definition = CONFIG_FIELD_DEFINITIONS[key];
        const value = (configWithSystemInfo as Record<string, unknown>)[key];
        return {
          key,
          value: value === undefined ? null : value,
          valueType: definition.valueType,
          editable: true,
        };
      });

      // Ensure sensitive project file entries are present
      const sensitiveEntries: Array<{ key: string; valueType: 'string' | 'array' | 'boolean'; defaultValue: unknown }> = [
        { key: 'sensitiveProjectFilePolicy', valueType: 'string', defaultValue: 'require_explicit_override' },
        { key: 'sensitiveProjectFileExtraPatterns', valueType: 'array', defaultValue: [] },
        { key: 'sensitiveProjectFileAllowedPatterns', valueType: 'array', defaultValue: ['.env.example', '.env.sample', '.env.template'] },
        { key: 'sensitiveProjectFileAudit', valueType: 'boolean', defaultValue: true },
      ];
      for (const se of sensitiveEntries) {
        if (!entries.some((e) => e.key === se.key)) {
          const val = (configWithSystemInfo as Record<string, unknown>)[se.key];
          entries.push({
            key: se.key,
            value: val !== undefined ? val : se.defaultValue,
            valueType: se.valueType,
            editable: true,
          });
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: `Current configuration:\n${JSON.stringify(configWithSystemInfo, null, 2)}`
        }],
        structuredContent: {
          config: configWithSystemInfo,
          uiHints: {
            availableShells,
          },
          entries,
        },
      };
    }

    // DEFAULT COMPACT MODE (< 2,048 bytes)
    const compactConfig = {
      allowedDirectories: config.allowedDirectories ?? [],
      blockedCommands: config.blockedCommands ?? [],
      telemetryEnabled: config.telemetryEnabled,
      clientId: config.clientId,
      sensitiveProjectFilePolicy: (config as Record<string, unknown>).sensitiveProjectFilePolicy ?? 'require_explicit_override',
      sensitiveProjectFileExtraPatterns: (config as Record<string, unknown>).sensitiveProjectFileExtraPatterns ?? [],
      sensitiveProjectFileAllowedPatterns: (config as Record<string, unknown>).sensitiveProjectFileAllowedPatterns ?? ['.env.example', '.env.sample', '.env.template'],
      sensitiveProjectFileAudit: (config as Record<string, unknown>).sensitiveProjectFileAudit ?? true,
    };

    const blockedCount = Array.isArray(compactConfig.blockedCommands) ? compactConfig.blockedCommands.length : 0;
    const textSummary = `Desktop Commander config active (${blockedCount} blocked).`;

    // Core editable entries excluding duplicate blockedCommands array
    const compactKeys = CONFIG_FIELD_KEYS.filter((k) => k !== 'blockedCommands');
    const entries: Array<{ key: string; value: unknown; valueType: string; editable: boolean }> = compactKeys.map((key) => {
      const definition = CONFIG_FIELD_DEFINITIONS[key];
      const value = (config as Record<string, unknown>)[key];
      return {
        key,
        value: value === undefined ? null : value,
        valueType: definition.valueType,
        editable: true,
      };
    });

    // Ensure sensitive project file policy entries are included in entries
    const sensitiveEntries: Array<{ key: string; valueType: 'string' | 'array' | 'boolean'; defaultValue: unknown }> = [
      { key: 'sensitiveProjectFilePolicy', valueType: 'string', defaultValue: 'require_explicit_override' },
      { key: 'sensitiveProjectFileExtraPatterns', valueType: 'array', defaultValue: [] },
      { key: 'sensitiveProjectFileAllowedPatterns', valueType: 'array', defaultValue: ['.env.example', '.env.sample', '.env.template'] },
      { key: 'sensitiveProjectFileAudit', valueType: 'boolean', defaultValue: true },
    ];
    for (const se of sensitiveEntries) {
      if (!entries.some((e) => e.key === se.key)) {
        const val = (config as Record<string, unknown>)[se.key];
        entries.push({
          key: se.key,
          value: val !== undefined ? val : se.defaultValue,
          valueType: se.valueType,
          editable: true,
        });
      }
    }

    const payload = {
      content: [{
        type: "text" as const,
        text: textSummary,
      }],
      structuredContent: {
        config: compactConfig,
        entries,
      },
    };

    // Reserve space for the JSON-RPC envelope and server result normalization.
    // Configurable arrays/strings are unbounded; expose explicit omission metadata
    // rather than silently replacing security controls with empty lists.
    const compactResultBudget = 1920;
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') <= compactResultBudget) {
      return payload;
    }
    const summaryConfig: Record<string, unknown> = {};
    const omittedFields: string[] = [];
    for (const [key, value] of Object.entries(compactConfig)) {
      if (Buffer.byteLength(JSON.stringify(value) ?? 'null', 'utf8') <= 256) {
        summaryConfig[key] = value;
      } else {
        omittedFields.push(key);
      }
    }
    const summary = {
      content: [{ type: 'text' as const, text: 'Compact configuration summary. Request verbose:true for all values and editable entries.' }],
      structuredContent: {
        config: summaryConfig,
        entries: [],
        requiresVerbose: true,
        omittedFields,
        fieldCounts: Object.fromEntries(Object.entries(compactConfig)
          .filter(([, value]) => Array.isArray(value))
          .map(([key, value]) => [key, (value as unknown[]).length])),
      },
    };
    // Even individually small values may collectively exceed the summary budget.
    if (Buffer.byteLength(JSON.stringify(summary), 'utf8') > compactResultBudget) {
      summary.structuredContent.config = {};
      summary.structuredContent.omittedFields = Object.keys(compactConfig);
    }
    return summary;
  } catch (error) {
    console.error(`Error in getConfig: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
    // Return empty config rather than crashing
    return {
      content: [{
        type: "text",
        text: `Error getting configuration: ${error instanceof Error ? error.message : String(error)}\nUsing empty configuration.`
      }],
    };
  }
}

/**
 * Set a specific config value
 */
export async function setConfigValue(args: unknown) {
  console.error(`setConfigValue called with args: ${JSON.stringify(args)}`);
  try {
    const parsed = SetConfigValueArgsSchema.safeParse(args);
    if (!parsed.success) {
      console.error(`Invalid arguments for set_config_value: ${parsed.error}`);
      return {
        content: [{
          type: "text",
          text: `Invalid arguments: ${parsed.error}`
        }],
        isError: true
      };
    }

    if (!ALLOWED_CONFIG_KEYS.has(parsed.data.key)) {
      return {
        content: [{
          type: "text",
          text: `Key "${parsed.data.key}" is not configurable via this tool. Allowed keys: ${[...ALLOWED_CONFIG_KEYS].join(', ')}`
        }],
        isError: true
      };
    }

    try {
      const fieldDefinition = ALL_CONFIG_FIELD_DEFINITIONS[parsed.data.key];
      // Parse string values that should be arrays or objects
      let valueToStore = parsed.data.value;

      if ('options' in fieldDefinition && fieldDefinition.options) {
        if (typeof valueToStore !== 'string' || !(fieldDefinition.options as readonly string[]).includes(valueToStore)) {
          return {
            content: [{
              type: "text",
              text: `Value for ${parsed.data.key} must be one of: ${fieldDefinition.options.join(', ')}.`
            }],
            isError: true
          };
        }
      }
      
      // If the value is a string that looks like an array or object, try to parse it
      if (typeof valueToStore === 'string' && 
          (valueToStore.startsWith('[') || valueToStore.startsWith('{'))) {
        try {
          valueToStore = JSON.parse(valueToStore);
          console.error(`Parsed string value to object/array: ${JSON.stringify(valueToStore)}`);
        } catch (parseError) {
          console.error(`Failed to parse string as JSON, using as-is: ${parseError}`);
        }
      }

      // Special handling for known array configuration keys
      if (fieldDefinition.valueType === 'array' && !Array.isArray(valueToStore)) {
        if (typeof valueToStore === 'string') {
          const originalString = valueToStore;
          try {
            const parsedValue = JSON.parse(originalString);
            valueToStore = parsedValue;
          } catch (parseError) {
            console.error(`Failed to parse string as array for ${parsed.data.key}: ${parseError}`);
            // If parsing failed and it's a single value, convert to an array with one item
            if (!originalString.includes('[')) {
              valueToStore = [originalString];
            }
          }
        } else if (valueToStore !== null) {
          // If not a string or array (and not null), convert to an array with one item
          valueToStore = [String(valueToStore)];
        }
        
        // Ensure the value is an array after all our conversions
        if (!Array.isArray(valueToStore)) {
          console.error(`Value for ${parsed.data.key} is still not an array, converting to array`);
          valueToStore = [String(valueToStore)];
        }
      }

      // Normalize and validate numeric configuration fields.
      if (fieldDefinition.valueType === 'number') {
        if (typeof valueToStore === 'string' && valueToStore.trim() !== '') {
          valueToStore = Number(valueToStore);
        }

        if (typeof valueToStore !== 'number' || !Number.isFinite(valueToStore) || !Number.isInteger(valueToStore)) {
          return {
            content: [{
              type: "text",
              text: `Value for ${parsed.data.key} must be a finite integer.`
            }],
            isError: true
          };
        }

        if (parsed.data.key === 'processStartOutputLineLimit') {
          if (valueToStore !== 0 && (valueToStore < 5 || valueToStore > 500)) {
            return {
              content: [{
                type: "text",
                text: 'Value for processStartOutputLineLimit must be zero (disabled) or between 5 and 500 lines.'
              }],
              isError: true
            };
          }
        } else if (valueToStore <= 0) {
          return {
            content: [{
              type: "text",
              text: `Value for ${parsed.data.key} must be greater than zero.`
            }],
            isError: true
          };
        }
      }

      // Harden boolean fields against stringly-typed inputs like "false".
      if (fieldDefinition.valueType === 'boolean') {
        if (typeof valueToStore === 'string') {
          const normalized = valueToStore.trim().toLowerCase();
          if (normalized === 'true') {
            valueToStore = true;
          } else if (normalized === 'false') {
            valueToStore = false;
          }
        }

        if (typeof valueToStore !== 'boolean') {
          return {
            content: [{
              type: "text",
              text: `Value for ${parsed.data.key} must be boolean true/false.`
            }],
            isError: true
          };
        }
      }

      // Numbers may arrive as strings ("5000"); null clears the value back to its default.
      if (fieldDefinition.valueType === 'number' && valueToStore !== null) {
        const numeric = typeof valueToStore === 'string' && valueToStore.trim() !== '' ? Number(valueToStore) : valueToStore;
        if (typeof numeric !== 'number' || !Number.isFinite(numeric)) {
          return {
            content: [{
              type: "text",
              text: `Value for ${parsed.data.key} must be a number.`
            }],
            isError: true
          };
        }
        valueToStore = numeric;
      }

      // If persistence fails, keep the user-visible value effective and queue
      // it for the next durable mutation rather than silently losing it.
      await configManager.setValue(parsed.data.key, valueToStore, { holdIfNotSaved: true });
      // Get the updated configuration to show the user
      const updatedConfig = await configManager.getConfig();
      console.error(`setConfigValue: Successfully set ${parsed.data.key} to ${JSON.stringify(valueToStore)}`);
      return {
        content: [{
          type: "text",
          text: `Successfully set ${parsed.data.key} to ${JSON.stringify(valueToStore, null, 2)}\n\nUpdated configuration:\n${JSON.stringify(updatedConfig, null, 2)}`
        }],
      };
    } catch (saveError: any) {
      console.error(`Error saving config: ${saveError.message}`);
      // Continue with in-memory change but report error
      return {
        content: [{
          type: "text", 
          text: `Value changed in memory but couldn't be saved to disk: ${saveError.message}`
        }],
        isError: true
      };
    }
  } catch (error) {
    console.error(`Error in setConfigValue: ${error instanceof Error ? error.message : String(error)}`);
    console.error(error instanceof Error && error.stack ? error.stack : 'No stack trace available');
    return {
      content: [{
        type: "text",
        text: `Error setting value: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
