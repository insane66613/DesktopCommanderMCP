export type ConfigFieldValueType = 'string' | 'number' | 'boolean' | 'array' | 'null';

export type ConfigFieldDefinition = {
  label: string;
  description: string;
  valueType: ConfigFieldValueType;
  options?: readonly string[];
};

// Single source of truth for user-editable configuration fields.
export const CONFIG_FIELD_DEFINITIONS = {
  blockedCommands: {
    label: 'Blocked Commands',
    description: 'This is your personal safety blocklist. If a command appears here, Desktop Commander will refuse to run it even if a prompt asks for it. Add risky commands you never want executed by mistake.',
    valueType: 'array',
  },
  allowedDirectories: {
    label: 'Allowed Folders',
    description: 'These are the folders Desktop Commander is allowed to read and edit. Think of this as a permission list. Keeping it small is safer. If this list is empty, Desktop Commander can access your entire filesystem.',
    valueType: 'array',
  },
  sensitiveProjectFilePolicy: {
    label: 'Sensitive Project File Policy',
    description: 'Controls export_project_file when a filename matches a protected credential/secret pattern. Block denies all sensitive exports; Require explicit override requires allowSensitiveProjectFile=true on that individual call; Allow permits them normally.',
    valueType: 'string',
    options: ['block', 'require_explicit_override', 'allow'],
  },
  sensitiveProjectFileExtraPatterns: {
    label: 'Extra Sensitive File Patterns',
    description: 'Additional filename patterns treated as sensitive by export_project_file. Built-in credential and private-key patterns always remain active. Wildcards use *.',
    valueType: 'array',
  },
  sensitiveProjectFileAllowedPatterns: {
    label: 'Sensitive File Exceptions',
    description: 'Filename patterns explicitly treated as safe even when they match a built-in or extra sensitive pattern. Defaults include .env.example, .env.sample, and .env.template.',
    valueType: 'array',
  },
  sensitiveProjectFileAudit: {
    label: 'Sensitive File Audit Log',
    description: 'Log blocked sensitive export attempts and successful explicit overrides without logging file contents.',
    valueType: 'boolean',
  },
  defaultShell: {
    label: 'Default Shell',
    description: 'This is the shell used for new command sessions (for example /bin/bash or /bin/zsh). Only change this if you know your environment requires a specific shell.',
    valueType: 'string',
  },
  telemetryEnabled: {
    label: 'Anonymous Telemetry',
    description: 'When on, Desktop Commander sends anonymous usage information that helps improve product quality. When off, no telemetry data is sent.',
    valueType: 'boolean',
  },
  fileReadLineLimit: {
    label: 'File Read Limit',
    description: 'Maximum number of lines returned from a file in one read action. Lower numbers keep responses short and safer; higher numbers return more text at once.',
    valueType: 'number',
  },
  fileWriteLineLimit: {
    label: 'File Write Limit',
    description: 'Maximum number of lines that can be written in one edit operation. This helps prevent accidental oversized writes and keeps file changes predictable.',
    valueType: 'number',
  },
  processStartOutputLineLimit: {
    label: 'Command Preview Limit',
    description: 'Maximum number of initial command-output lines shown by start_process. Set to 0 to disable the initial output preview; full output remains available through read_process_output.',
    valueType: 'number',
  },
  filePreviewsEnabled: {
    label: 'File Previews',
    description: 'Show the interactive file-preview UI for file tools. Turn this off to keep normal file tool results while preventing preview widgets and their UI-origin refresh calls.',
    valueType: 'boolean',
  },
  mcpUiPreviewsEnabled: {
    label: 'MCP UI Previews',
    description: 'Show rich MCP preview widgets for supported Desktop Commander tools. Turn this off to use normal tool results without preview widgets.',
    valueType: 'boolean',
  },
} as const satisfies Record<string, ConfigFieldDefinition>;

export type ConfigFieldKey = keyof typeof CONFIG_FIELD_DEFINITIONS;

export const CONFIG_FIELD_KEYS = Object.keys(CONFIG_FIELD_DEFINITIONS) as ConfigFieldKey[];

export function isConfigFieldKey(value: string): value is ConfigFieldKey {
  return Object.prototype.hasOwnProperty.call(CONFIG_FIELD_DEFINITIONS, value);
}
