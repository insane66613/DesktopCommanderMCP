import { toolHistory } from '../utils/toolHistory.js';
import { GetRecentToolCallsArgsSchema, TrackUiEventArgsSchema } from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture_ui_event } from '../utils/capture.js';

type TrackUiEventParams = Record<string, string | number | boolean | null>;

export function buildTrackUiEventCapturePayload(event: string, component: string, params: TrackUiEventParams): Record<string, string | number | boolean | null> {
  return {
    ...params,
    component,
    event
  };
}

/**
 * Handle get_recent_tool_calls command
 */
export async function handleGetRecentToolCalls(args: unknown): Promise<ServerResult> {
  try {
    const parsed = GetRecentToolCallsArgsSchema.parse(args);
    
    // Use formatted version with local timezone
    const recentCalls = toolHistory.getRecentCallsFormatted({
      maxResults: parsed.maxResults,
      toolName: parsed.toolName,
      since: parsed.since
    });
    const calls = recentCalls.map(call => ({
      timestamp: call.timestamp,
      toolName: call.toolName,
      duration: call.duration,
      success: call.output.isError !== true,
      ...(parsed.includeDetails ? { arguments: call.arguments, output: call.output } : {})
    }));
    
    const stats = toolHistory.getStats();
    
    // Format the response (excluding file path per user request)
    const summary = `Tool Call History (${calls.length} results, ${stats.totalEntries} total in memory)`;
    
    return {
      content: [{
        type: "text",
        text: summary
      }],
      structuredContent: {
        summary,
        calls,
        count: calls.length,
        success: true,
      },
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error getting tool history: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Handle track_ui_event command
 */
export async function handleTrackUiEvent(args: unknown): Promise<ServerResult> {
  try {
    const parsed = TrackUiEventArgsSchema.parse(args);

    await capture_ui_event('mcp_ui_event', buildTrackUiEventCapturePayload(parsed.event, parsed.component, parsed.params));

    return {
      content: [{
        type: "text",
        text: `Tracked UI event: ${parsed.event}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error tracking UI event: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
