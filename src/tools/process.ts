import { exec } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { ProcessInfo, ServerResult } from '../types.js';
import { KillProcessArgsSchema } from './schemas.js';
import { terminalManager } from '../terminal-manager.js';
import { terminatePid } from '../utils/process-tree.js';

const execAsync = promisify(exec);

/**
 * Parse `tasklist /FO CSV /NH` output (#662). Fields per row, all quoted:
 * [Image Name, PID, Session Name, Session#, Mem Usage]. CSV instead of the
 * default table: image names can contain spaces and Mem Usage contains
 * thousands separators, so positional whitespace splitting can't work.
 * tasklist has no live per-process CPU%, so cpu is reported as n/a.
 */
export function parseWindowsTasklistCsv(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      const fields = (line.match(/"([^"]*)"/g) || []).map(f => f.slice(1, -1));
      return {
        pid: parseInt(fields[1], 10),
        command: fields[0] ?? '',
        cpu: 'n/a',
        memory: fields[4] ?? '',
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

/**
 * Parse `ps aux` output: 11 whitespace-separated columns, COMMAND from
 * column 10 onward (it can contain spaces, so it must be rejoined, not
 * taken as the last token).
 */
export function parsePsAux(stdout: string): ProcessInfo[] {
  return stdout.split(/\r?\n/)
    .slice(1)
    .filter(Boolean)
    .map(line => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[1], 10),
        command: parts.slice(10).join(' ') || parts[parts.length - 1],
        cpu: parts[2],
        memory: parts[3],
      } as ProcessInfo;
    })
    .filter(p => !Number.isNaN(p.pid));
}

export async function listProcesses(): Promise<ServerResult> {
  const isWindows = os.platform() === 'win32';
  const command = isWindows ? 'tasklist /FO CSV /NH' : 'ps aux';
  try {
    const { stdout } = await execAsync(command);
    const processes = isWindows ? parseWindowsTasklistCsv(stdout) : parsePsAux(stdout);

    const text = processes.map(p =>
      `PID: ${p.pid}, Command: ${p.command}, CPU: ${p.cpu}, Memory: ${p.memory}`
    ).join('\n');

    return {
      content: [{
        type: "text",
        text,
      }],
      structuredContent: {
        processes,
        count: processes.length,
        text,
        success: true,
      },
    };
  } catch (error) {
    const text = `Error: Failed to list processes: ${error instanceof Error ? error.message : String(error)}`;
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        processes: [],
        count: 0,
        text,
        success: false,
        error: text,
      },
      isError: true,
    };
  }
}

export async function killProcess(args: unknown): Promise<ServerResult> {
  const parsed = KillProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for kill_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const pid = parsed.data.pid;
  if (pid === process.pid || pid === process.ppid) {
    return {
      content: [{ type: 'text', text: `Error: Refusing to terminate DeskCommand's runtime or direct supervisor PID ${pid}` }],
      isError: true,
    };
  }

  try {
    // A PID returned by start_process is a managed shell. Its descendants
    // must be stopped too; killing only its PID strands dev servers and jobs.
    if (terminalManager.getSession(pid)) {
      const outcome = await terminalManager.forceTerminateAndWait(pid);
      if (outcome !== 'ended') {
        return {
          content: [{ type: 'text', text: `Error: Could not confirm termination of managed process tree ${pid} (${outcome})` }],
          isError: true,
        };
      }
    } else {
      // Preserve PID-only scope for unrelated external processes. Never
      // kill the external process's descendants without explicit ownership.
      await terminatePid(pid);
    }
    return { content: [{ type: 'text', text: `Successfully terminated process ${pid}` }] };
  } catch (error) {
    return {
      content: [{ type: 'text', text: `Error: Failed to kill process: ${error instanceof Error ? error.message : String(error)}` }],
      isError: true,
    };
  }
}
