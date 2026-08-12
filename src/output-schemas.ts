/** JSON output schemas advertised in tools/list for ChatGPT / MCP clients. */

export type JsonSchema = Record<string, unknown>;

const FILE_PREVIEW_PROPERTIES: JsonSchema = {
  fileName: { type: ['string', 'null'] },
  filePath: { type: ['string', 'null'] },
  name: { type: ['string', 'null'] },
  path: { type: ['string', 'null'] },
  fileType: { type: ['string', 'null'] },
  content: { type: ['string', 'array', 'object', 'null'] },
  imageData: { type: ['string', 'null'] },
  mimeType: { type: ['string', 'null'] },
};

export const FILE_PREVIEW_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  properties: FILE_PREVIEW_PROPERTIES,
  additionalProperties: true,
};

const ACTION_RESULT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['text', 'success'],
  properties: {
    text: { type: 'string' },
    message: { type: ['string', 'null'] },
    success: { type: 'boolean' },
    detail: { type: ['string', 'null'] },
    error: { type: ['string', 'null'] },
  },
  additionalProperties: true,
};

const CONFIG_ENTRY_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['key', 'value', 'valueType', 'editable'],
  properties: {
    key: { type: 'string' },
    value: {},
    valueType: { type: 'string' },
    editable: { type: 'boolean' },
  },
  additionalProperties: true,
};

const GET_CONFIG_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['config', 'entries'],
  properties: {
    config: { type: 'object', additionalProperties: true },
    entries: { type: 'array', items: CONFIG_ENTRY_SCHEMA },
    uiHints: { type: ['object', 'null'], additionalProperties: true },
  },
  additionalProperties: true,
};

const READ_FILE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['filePath', 'fileType'],
  properties: {
    ...FILE_PREVIEW_PROPERTIES,
    totalLines: { type: ['integer', 'number', 'null'] },
    offset: { type: ['integer', 'number', 'null'] },
    length: { type: ['integer', 'number', 'null'] },
  },
  additionalProperties: true,
};

const PROCESS_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['text', 'success'],
  properties: {
    pid: { type: ['integer', 'number', 'null'] },
    text: { type: 'string' },
    output: { type: ['string', 'null'] },
    isBlocked: { type: ['boolean', 'null'] },
    isFinished: { type: ['boolean', 'null'] },
    exitCode: { type: ['integer', 'number', 'null'] },
    state: { type: ['string', 'null'] },
    success: { type: 'boolean' },
    error: { type: ['string', 'null'] },
  },
  additionalProperties: true,
};

const SEARCH_RESULT_ITEM_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    type: { type: ['string', 'null'] },
    file: { type: ['string', 'null'] },
    line: { type: ['integer', 'number', 'null'] },
    match: { type: ['string', 'null'] },
  },
  additionalProperties: true,
};

const SEARCH_SESSION_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['sessionId', 'status', 'success'],
  properties: {
    sessionId: { type: ['string', 'null'] },
    status: { type: 'string' },
    pattern: { type: ['string', 'null'] },
    path: { type: ['string', 'null'] },
    totalResults: { type: ['integer', 'number', 'null'] },
    isComplete: { type: ['boolean', 'null'] },
    text: { type: ['string', 'null'] },
    success: { type: 'boolean' },
    results: { type: ['array', 'null'], items: SEARCH_RESULT_ITEM_SCHEMA },
  },
  additionalProperties: true,
};

const SEARCH_MORE_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['sessionId', 'status', 'success'],
  properties: {
    sessionId: { type: ['string', 'null'] },
    status: { type: 'string' },
    totalResults: { type: ['integer', 'number', 'null'] },
    totalMatches: { type: ['integer', 'number', 'null'] },
    returnedCount: { type: ['integer', 'number', 'null'] },
    hasMoreResults: { type: ['boolean', 'null'] },
    isComplete: { type: ['boolean', 'null'] },
    text: { type: ['string', 'null'] },
    success: { type: 'boolean' },
    results: { type: ['array', 'null'], items: SEARCH_RESULT_ITEM_SCHEMA },
  },
  additionalProperties: true,
};

const SEARCH_LIST_OUTPUT_SCHEMA: JsonSchema = {
  type: 'object',
  required: ['searches', 'count', 'success'],
  properties: {
    searches: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'] },
          pattern: { type: ['string', 'null'] },
          status: { type: ['string', 'null'] },
          totalResults: { type: ['integer', 'number', 'null'] },
        },
        additionalProperties: true,
      },
    },
    count: { type: 'integer' },
    text: { type: ['string', 'null'] },
    success: { type: 'boolean' },
  },
  additionalProperties: true,
};

export const OUTPUT_SCHEMAS: Record<string, JsonSchema> = {
  get_config: GET_CONFIG_OUTPUT_SCHEMA,
  set_config_value: ACTION_RESULT_SCHEMA,
  // File-preview handlers emit structuredContent only for origin:'ui' calls.
  // Advertising an outputSchema for ordinary model-facing calls makes MCP
  // hosts reject their valid text-only results before the model can consume
  // them. Widget-originated calls still carry their rich preview metadata.
  read_multiple_files: {
    type: 'object',
    required: ['summary', 'success'],
    properties: {
      summary: { type: 'string' },
      text: { type: ['string', 'null'] },
      success: { type: 'boolean' },
      files: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
    },
    additionalProperties: true,
  },
  write_pdf: ACTION_RESULT_SCHEMA,
  create_directory: ACTION_RESULT_SCHEMA,
  move_file: ACTION_RESULT_SCHEMA,
  get_file_info: {
    type: 'object',
    required: ['info', 'success'],
    properties: {
      info: { type: 'object', additionalProperties: true },
      text: { type: ['string', 'null'] },
      success: { type: 'boolean' },
      error: { type: ['string', 'null'] },
    },
    additionalProperties: true,
  },
  start_process: PROCESS_OUTPUT_SCHEMA,
  read_process_output: PROCESS_OUTPUT_SCHEMA,
  interact_with_process: PROCESS_OUTPUT_SCHEMA,
  force_terminate: ACTION_RESULT_SCHEMA,
  list_sessions: {
    type: 'object',
    required: ['sessions', 'success'],
    properties: {
      sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: ['integer', 'number', 'null'] },
      text: { type: ['string', 'null'] },
      success: { type: 'boolean' },
    },
    additionalProperties: true,
  },
  list_processes: {
    type: 'object',
    required: ['processes', 'success'],
    properties: {
      processes: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: ['integer', 'number', 'null'] },
      text: { type: ['string', 'null'] },
      success: { type: 'boolean' },
    },
    additionalProperties: true,
  },
  kill_process: ACTION_RESULT_SCHEMA,
  start_search: SEARCH_SESSION_OUTPUT_SCHEMA,
  get_more_search_results: SEARCH_MORE_OUTPUT_SCHEMA,
  stop_search: ACTION_RESULT_SCHEMA,
  list_searches: SEARCH_LIST_OUTPUT_SCHEMA,
  get_usage_stats: {
    type: 'object',
    required: ['text', 'success'],
    properties: {
      text: { type: 'string' },
      success: { type: 'boolean' },
      stats: { type: ['object', 'null'], additionalProperties: true },
    },
    additionalProperties: true,
  },
  get_recent_tool_calls: {
    type: 'object',
    required: ['calls', 'success'],
    properties: {
      summary: { type: ['string', 'null'] },
      calls: { type: 'array', items: { type: 'object', additionalProperties: true } },
      count: { type: ['integer', 'number', 'null'] },
      text: { type: ['string', 'null'] },
      success: { type: 'boolean' },
    },
    additionalProperties: true,
  },
  get_prompts: {
    type: 'object',
    required: ['text', 'success'],
    properties: {
      text: { type: 'string' },
      success: { type: 'boolean' },
      prompt: { type: ['object', 'null'], additionalProperties: true },
      prompts: { type: ['array', 'null'], items: { type: 'object', additionalProperties: true } },
    },
    additionalProperties: true,
  },
  give_feedback_to_desktop_commander: ACTION_RESULT_SCHEMA,
};

export function outputSchemaForTool(name: string): JsonSchema | undefined {
  return OUTPUT_SCHEMAS[name];
}
