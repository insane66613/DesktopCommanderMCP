import type { ServerResult } from './types.js';

function textFromContent(content: ServerResult['content']): string {
  if (!content?.length) return '';
  return content
    .map((item) => (item.type === 'text' && typeof item.text === 'string' ? item.text : ''))
    .filter(Boolean)
    .join('\n');
}

function actionResult(text: string, isError: boolean): Record<string, unknown> {
  const success = !isError && !text.toLowerCase().startsWith('error');
  const payload: Record<string, unknown> = {
    text: text.trim(),
    success,
    message: text.trim(),
  };
  if (!success) payload.error = text.trim();
  const match = text.match(/^Successfully\s+(.+)$/im);
  if (success && match) payload.detail = match[1].trim();
  return payload;
}

function processFields(text: string): Record<string, unknown> {
  const pidMatch = text.match(/\bPID[:\s]+(-?\d+)/i);
  const pid = pidMatch ? Number.parseInt(pidMatch[1], 10) : null;
  const isFinished = /Process exited|exited with code|No active session|terminated|Cleared virtual/i.test(text);
  const isBlocked = !isFinished && (/Process is running|read_process_output/i.test(text));
  const exitMatch = text.match(/(?:exit(?:ed)?|code)[:\s]+(-?\d+)/i);
  return {
    pid,
    text,
    output: text,
    isBlocked,
    isFinished,
    exitCode: exitMatch ? Number.parseInt(exitMatch[1], 10) : null,
    state: isFinished ? 'finished' : isBlocked ? 'blocked' : 'running',
  };
}

function searchStartFields(text: string): Record<string, unknown> {
  const sessionMatch = text.match(/session[:\s]+(\S+)/i);
  const totalMatch = text.match(/Total results(?: found)?[:\s]+(\d+)/i);
  return {
    sessionId: sessionMatch?.[1] ?? null,
    status: text.includes('COMPLETED') ? 'COMPLETED' : 'RUNNING',
    text,
    totalResults: totalMatch ? Number.parseInt(totalMatch[1], 10) : 0,
    isComplete: text.includes('COMPLETED'),
  };
}

function searchMoreFields(text: string): Record<string, unknown> {
  const sessionMatch = text.match(/session[:\s]+(\S+)/i);
  const totalMatch = text.match(/Total results(?: found)?[:\s]+(\d+)/i);
  const matchesMatch = text.match(/\((\d+)\s+matches\)/i);
  return {
    sessionId: sessionMatch?.[1] ?? null,
    status: text.includes('COMPLETED') ? 'COMPLETED' : 'IN_PROGRESS',
    text,
    totalResults: totalMatch ? Number.parseInt(totalMatch[1], 10) : 0,
    totalMatches: matchesMatch ? Number.parseInt(matchesMatch[1], 10) : null,
    isComplete: text.includes('COMPLETED'),
    hasMoreResults: text.includes('More results available'),
  };
}

function searchListFields(text: string): Record<string, unknown> {
  if (text.includes('No active searches')) {
    return { searches: [], text, count: 0 };
  }
  const sessions: Array<Record<string, unknown>> = [];
  for (const block of text.split(/\n(?=Session:\s)/)) {
    if (!block.trim().startsWith('Session:')) continue;
    sessions.push({
      id: block.match(/Session:\s+(\S+)/)?.[1] ?? null,
      pattern: block.match(/Pattern:\s+"([^"]*)"/)?.[1] ?? null,
      status: block.match(/Status:\s+(\S+)/)?.[1] ?? null,
      totalResults: Number.parseInt(block.match(/Results:\s+(\d+)/)?.[1] ?? '0', 10),
    });
  }
  return { searches: sessions, text, count: sessions.length };
}

function buildStructuredContent(
  toolName: string,
  text: string,
  isError: boolean,
): Record<string, unknown> | undefined {
  const actionTools = new Set([
    'create_directory',
    'move_file',
    'kill_process',
    'force_terminate',
    'stop_search',
    'write_pdf',
    'give_feedback_to_desktop_commander',
    'set_config_value',
  ]);
  if (actionTools.has(toolName)) {
    return actionResult(text, isError);
  }
  if (toolName === 'start_process' || toolName === 'read_process_output' || toolName === 'interact_with_process') {
    return { ...processFields(text), success: !isError };
  }
  if (toolName === 'start_search') {
    return { ...searchStartFields(text), success: !isError };
  }
  if (toolName === 'get_more_search_results') {
    return { ...searchMoreFields(text), success: !isError };
  }
  if (toolName === 'list_searches') {
    return { ...searchListFields(text), success: !isError };
  }
  if (toolName === 'get_file_info') {
    const info: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
      const idx = line.indexOf(':');
      if (idx === -1) continue;
      info[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
    return { info, text, success: !isError };
  }
  if (toolName === 'read_multiple_files') {
    return { text, success: !isError, summary: text.split('\n', 1)[0] };
  }
  return undefined;
}

function normalizeFilePreview(structured: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...structured };
  if (typeof normalized.filePath === 'string' && normalized.path === undefined) {
    normalized.path = normalized.filePath;
  }
  if (typeof normalized.fileName === 'string' && normalized.name === undefined) {
    normalized.name = normalized.fileName;
  }
  return normalized;
}

export function enrichStructuredContent(toolName: string, result: ServerResult): ServerResult {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    const previewTools = new Set(['read_file', 'write_file', 'edit_block', 'list_directory', 'get_config']);
    if (previewTools.has(toolName)) {
      result.structuredContent = normalizeFilePreview(result.structuredContent as Record<string, unknown>);
    }
    return result;
  }

  const text = textFromContent(result.content);
  if (!text) return result;

  const structured = buildStructuredContent(toolName, text, Boolean(result.isError));
  if (structured) {
    result.structuredContent = structured;
  }
  return result;
}
