import { spawn } from 'child_process';
import { boundedText, serializedBytes, DEFAULT_PROCESS_PAGE_BYTES, MAX_TOOL_RESPONSE_BYTES } from './utils/response-budget.js';
import { existsSync } from 'fs';
import path from 'path';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { configManager } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState } from './utils/process-detection.js';
import { commandManager } from './command-manager.js';
import { getCommandEnvironment } from './utils/command-environment.js';
import { terminateProcessTree } from './utils/process-tree.js';

export const WINDOWS_POWERSHELL_7_PATH = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe';
const WINDOWS_POWERSHELL_5_DISABLED_MESSAGE = 'Error: Windows PowerShell 5.1 is disabled. Use PowerShell 7 (pwsh.exe).';

export function resolveWindowsPowerShell7Fallback(): string | null {
  if (process.platform !== 'win32') return null;
  return existsSync(WINDOWS_POWERSHELL_7_PATH) ? WINDOWS_POWERSHELL_7_PATH : null;
}

function powershell5DisabledResult(): CommandExecutionResult {
  return { pid: -1, output: WINDOWS_POWERSHELL_5_DISABLED_MESSAGE, isBlocked: false };
}


export interface SessionStateVersion {
  pid: number;
  generation: number;
  lifecycleVersion: number;
  outputVersion: number;
  lastReadIndex: number;
  lastReadCharacter: number;
}

export interface VersionedTerminalSession extends TerminalSession {
  generation: number;
  outputVersion: number;
  lifecycleVersion: number;
  outputError?: string;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       // Line-based buffer (consistent with active sessions)
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  evictedLines: number;        // Carried over from the active session (see TerminalSession)
  evictedChars: number;
  lastReadIndex: number;
  lastReadCharacter?: number;
  generation: number;
  outputVersion: number;
  lifecycleVersion: number;
  bufferedChars: number;
  outputClosed: boolean;
  outputError?: string;
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
export const MAX_BUFFERED_OUTPUT_CHARS = 50 * 1024 * 1024;  // per session; oldest lines evicted first
const MAX_LINE_CHARS = 1024 * 1024;                  // force-split longer lines so eviction can work
const MAX_WAIT_OUTPUT_CHARS = 2 * 1024 * 1024;       // start_process wait buffer (prompt/state detection)
const MAX_COMPLETED_SESSIONS = 100;
const MAX_EVICTED_SESSION_MARKERS = 100;

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
  outputError?: string;       // Sanitized stdout/stderr failure diagnostic
  nextOffset: number;
  nextCharacterOffset: number;
  sizeLimited: boolean;
}

export interface ReadOutputOptions {
  maxBytes?: number;
  pageSize?: number;
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
}

export interface WindowLaunchControls {
  visible?: boolean;
  keepOpen?: boolean;
  windowTitle?: string;
}

/**
 * A detached Windows pwsh with pipe-backed stdio immediately exits on the
 * managed host, including -NoExit. Keep its stdio attached for all visible
 * pwsh launches so both the console and its lifecycle remain controllable.
 * The host may not surface a separate OS window; this is a managed session.
 */
export function shouldDetachVisibleShell(shell: string, platform: string = process.platform): boolean {
  const shellName = path.basename(shell).toLowerCase();
  return !(platform === 'win32' && (shellName === 'pwsh' || shellName === 'pwsh.exe'));
}

/**
 * A visible, persistent or titled console is supported only by Windows pwsh 7.
 * Reject impossible combinations instead of silently ignoring caller controls.
 */
export function validateWindowLaunchControls(
  options: WindowLaunchControls | undefined,
  shell: string | boolean | undefined,
  platform: string = process.platform,
): string | null {
  if (!options?.keepOpen && options?.windowTitle === undefined) return null;
  if (!options.visible) return 'keep_open and window_title require visible=true.';
  if (platform !== 'win32') return 'keep_open and window_title are currently supported only on Windows.';
  if (typeof shell !== 'string' || !['pwsh', 'pwsh.exe'].includes(path.basename(shell).toLowerCase())) {
    return 'keep_open and window_title require the PowerShell 7 shell (pwsh.exe).';
  }
  if (options.windowTitle !== undefined && (
    !options.windowTitle.trim() || options.windowTitle.length > 128 ||
    /[\u0000-\u001f\u007f]/.test(options.windowTitle)
  )) {
    return 'window_title must be 1 to 128 characters without control characters.';
  }
  return null;
}

/** Get shell arguments, preserving the plain-command path for existing calls. */
export function getShellSpawnArgs(
  shellPath: string,
  command: string,
  options?: WindowLaunchControls,
): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  
  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // Automation must not execute interactive profiles or add their output to tool results.
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    // The title is passed separately via DC_WINDOW_TITLE. Never embed the
    // user-supplied title in a PowerShell command string (command injection).
    const titledCommand = options?.visible && options.windowTitle !== undefined
      ? 'try { $Host.UI.RawUI.WindowTitle = $env:DC_WINDOW_TITLE } catch { throw "Failed to set window title: $($_.Exception.Message)" }; ' + command
      : command;
    const keepOpen = options?.visible && options.keepOpen === true;
    return {
      executable: shellPath,
      args: ['-NoLogo', '-NoProfile', ...(keepOpen ? ['-NoExit'] : []), '-Command', titledCommand],
      useShellOption: false,
    };
  }
  
  // Windows PowerShell 5.1 is never a valid execution shell.
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    throw new Error(WINDOWS_POWERSHELL_5_DISABLED_MESSAGE);
  }
  
  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return { 
      executable: shellPath, 
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false 
    };
  }
  
  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return { 
    executable: command,
    args: [],
    useShellOption: shellPath 
  };
}

export class TerminalManager {
  private nextGeneration = 1;
  private sessions: Map<number, VersionedTerminalSession> = new Map();
  // Coalesce only concurrent tree termination; failed attempts must be retryable.
  // Key by the session object, not PID, to avoid PID-reuse collisions.
  private terminationInFlight = new WeakMap<VersionedTerminalSession, Promise<'ended' | 'failed'>>();
  private completedSessions: Map<number, CompletedSession> = new Map();
  private evictedCompletedSessions: Map<number, string> = new Map();

  getEvictedCompletionNotice(pid: number): string | null {
    return this.evictedCompletedSessions.get(pid) ?? null;
  }

  private pruneCompletedSessions(): void {
    while (this.completedSessions.size > MAX_COMPLETED_SESSIONS) {
      const oldestClosed = [...this.completedSessions].find(([, entry]) => entry.outputClosed);
      const oldest = oldestClosed ?? this.completedSessions.entries().next().value;
      if (!oldest) break;
      const [pid, entry] = oldest;
      this.completedSessions.delete(pid);
      if (!entry.outputClosed) {
        // Never let an inherited pipe keep an unbounded completed-output buffer.
        // The child may continue, but its output is no longer retained or replayed.
        entry.outputLines.length = 0;
        entry.bufferedChars = 0;
        this.evictedCompletedSessions.set(pid,
          `Completed PID ${pid} was evicted at the retention limit while inherited output pipes remained open. Remaining output was discarded; do not treat this as complete output.`);
        while (this.evictedCompletedSessions.size > MAX_EVICTED_SESSION_MARKERS) {
          const earliest = this.evictedCompletedSessions.keys().next().value;
          if (earliest === undefined) break;
          this.evictedCompletedSessions.delete(earliest);
        }
      }
    }
  }
  
  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  async sendInputToProcess(pid: number, input: string, timeoutMs: number = 15000, expectedGeneration?: number): Promise<boolean> {
    const session = this.sessions.get(pid);
    // Bind the input write to the same session identity as the captured output
    // cursor. The check and stdin.write occur synchronously without an await.
    if (expectedGeneration !== undefined && session?.generation !== expectedGeneration) return false;
    const stdin = session?.process.stdin;
    if (!stdin || stdin.destroyed || stdin.writableEnded || !stdin.writable) {
      return false;
    }
    const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (outcome: 'confirmed' | 'rejected' | 'indeterminate') => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        stdin.off('error', onError);
        stdin.off('close', onClose);
        stdin.off('finish', onClose);
        if (outcome === 'indeterminate') {
          reject(new Error('Input write outcome indeterminate after submission; input may have been delivered. Do not retry automatically.'));
        } else {
          resolve(outcome === 'confirmed');
        }
      };
      const onError = (_error: Error) => finish('indeterminate');
      const onClose = () => finish('indeterminate');
      stdin.once('error', onError);
      stdin.once('close', onClose);
      stdin.once('finish', onClose);
      timer = setTimeout(() => finish('indeterminate'), Math.max(1, Math.min(timeoutMs, 15000)));
      try {
        stdin.write(inputWithNewline, (error?: Error | null) => finish(error ? 'indeterminate' : 'confirmed'));
      } catch {
        finish('rejected');
      }
    });
  }
  
  async executeCommand(
    command: string,
    timeoutMs: number = DEFAULT_COMMAND_TIMEOUT,
    shell?: string,
    collectTiming: boolean = false,
    opts?: WindowLaunchControls & { excludeSelf?: boolean },
  ): Promise<CommandExecutionResult> {
    // Get the shell from config if not specified. On Windows, never delegate
    // an unresolved default to Node's `shell: true` path (cmd.exe): establish
    // PowerShell 7 explicitly or fail closed.
    let shellToUse: string | boolean | undefined = shell;
    const shellWasOmitted = shellToUse === undefined || (typeof shellToUse === 'string' && !shellToUse.trim());
    if (shellWasOmitted) {
      try {
        const config = await configManager.getConfig();
        shellToUse = config.defaultShell;
      } catch (error) {
        shellToUse = undefined;
      }
    }

    const shellStillUnresolved = shellToUse === undefined || (typeof shellToUse === 'string' && !shellToUse.trim());
    if (process.platform === 'win32' && shellStillUnresolved) {
      const pwsh7 = resolveWindowsPowerShell7Fallback();
      if (!pwsh7) {
        return {
          pid: -1,
          output: `Error: PowerShell 7 is required but was not found at ${WINDOWS_POWERSHELL_7_PATH}. Refusing to fall back to cmd.exe or Windows PowerShell 5.1.`,
          isBlocked: false
        };
      }
      shellToUse = pwsh7;
    } else if (shellStillUnresolved) {
      shellToUse = true;
    }

    // Fail closed if a caller selects Windows PowerShell 5.1 as the shell.
    if (process.platform === 'win32' && typeof shellToUse === 'string') {
      const selectedShell = path.basename(shellToUse).toLowerCase();
      if (selectedShell === 'powershell' || selectedShell === 'powershell.exe') {
        return powershell5DisabledResult();
      }
    }

    // Enforce the same invariant on the command body itself. This closes
    // shell-wrapper bypasses such as `cmd /c powershell.exe ...` and
    // `pwsh -Command "powershell.exe ..."` while allowing literal mentions.
    if (process.platform === 'win32' && commandManager.isLegacyWindowsPowerShellInvocation(command)) {
      return powershell5DisabledResult();
    }

    const windowError = validateWindowLaunchControls(opts, shellToUse);
    if (windowError) {
      return { pid: -1, output: `Error: ${windowError}`, isBlocked: false };
    }

    // For REPL interactions, we need to ensure stdin, stdout, and stderr are properly configured
    // Note: No special stdio options needed here, Node.js handles pipes by default

    // Enhance SSH commands automatically
    let enhancedCommand = command;
    if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
      enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      console.log(`Enhanced SSH command: ${enhancedCommand}`);
    }

    // Get the appropriate spawn configuration for the shell
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;
    
    if (typeof shellToUse === 'string') {
      // Use shell-specific configuration with login flags where appropriate
      spawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand, opts);
      spawnOptions = {
        env: {
          ...getCommandEnvironment(),
          TERM: 'xterm-256color'  // Better terminal compatibility
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };

      // Windows pwsh with redirected pipes exits immediately if detached.
      // Preserve the managed session lifecycle; actual window presentation is
      // host-dependent rather than guaranteed by windowsHide=false.
      if (opts?.visible) {
        spawnOptions.windowsHide = false;
        spawnOptions.detached = shouldDetachVisibleShell(shellToUse);
      }

      if (opts?.excludeSelf) {
        spawnOptions.env.DC_EXCLUDE_SELF = '1';
      }
      if (opts?.visible && opts.windowTitle !== undefined) {
        spawnOptions.env.DC_WINDOW_TITLE = opts.windowTitle;
      }

      // Add shell option if needed (for unknown shells)
      if (spawnConfig.useShellOption) {
        spawnOptions.shell = spawnConfig.useShellOption;
      }
    } else {
      // Preserve an explicit false (direct executable spawn); only an actually
      // unresolved value falls back to Node's default shell behavior.
      const shellOption = shellToUse ?? true;
      spawnConfig = {
        executable: enhancedCommand,
        args: [],
        useShellOption: shellOption
      };
      spawnOptions = {
        shell: shellOption,
        env: {
          ...getCommandEnvironment(),
          TERM: 'xterm-256color'
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };

      if (opts?.visible) {
        spawnOptions.windowsHide = false;
        spawnOptions.detached = true;
      }

      if (opts?.excludeSelf) {
        spawnOptions.env.DC_EXCLUDE_SELF = '1';
      }
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    // Spawn the process with appropriate arguments
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    let output = '';

    // spawn() reports failure asynchronously via an 'error' event; it does not
    // throw. Node rethrows an 'error' that has no listener as an uncaught
    // exception, and our process-level handler (src/index.ts) turns that into
    // process.exit(1). So an unresolvable executable — e.g. shell: "/usr/bin/bash"
    // on Windows — used to kill the entire MCP server one tick AFTER this
    // function had already returned "Failed to get process ID", making the crash
    // look unrelated to the command that caused it. Under `remote` the parent
    // then kept accepting tool calls over a dead stdio pipe ("Not connected").
    //
    // Attach before any return path below, and keep it for the session lifetime
    // so a later runtime error (EPIPE on a closed stdin, ...) can't crash us either.
    let forwardProcessError: ((err: Error) => void) | null = null;
    let pendingProcessError: Error | null = null;
    let outputStreamError: string | undefined;
    childProcess.on('error', (err: Error) => {
      if (forwardProcessError) {
        forwardProcessError(err);
      } else {
        pendingProcessError = err;
        console.error(`Process error for "${command}": ${err.message}`);
      }
    });
    // Child stream errors are separate from ChildProcess 'error'. A benign
    // EPIPE/ERR_STREAM_DESTROYED after exit must not crash the MCP host.
    for (const [name, stream] of [
      ['stdout', childProcess.stdout],
      ['stderr', childProcess.stderr],
      ['stdin', childProcess.stdin],
    ] as const) {
      stream?.on('error', (err: Error) => {
        console.error(`Child ${name} stream error for PID ${childProcess.pid ?? 'unknown'}: ${err.message}`);
        if (name !== 'stdin' && childProcess.pid) {
          const errorCode = 'code' in err && typeof err.code === 'string' && /^[A-Z_0-9]+$/.test(err.code)
            ? err.code : 'UNKNOWN';
          outputStreamError = `${name} stream failed (code ${errorCode}); process output may be incomplete.`;
          const current = this.sessions.get(childProcess.pid) ?? this.completedSessions.get(childProcess.pid);
          if (current) {
            current.outputError = outputStreamError;
            current.lifecycleVersion++;
          }
        }
      });
    }

    // Ensure childProcess.pid is defined before proceeding
    if (!childProcess.pid) {
      // Return a consistent error object instead of throwing
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }

    const session: VersionedTerminalSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0,
      generation: this.nextGeneration++,
      outputVersion: 0,
      lifecycleVersion: 0,
      outputError: outputStreamError,
    };

    this.sessions.set(childProcess.pid, session);
    this.completedSessions.delete(session.pid);
    this.evictedCompletedSessions.delete(session.pid);

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
      let timeoutFallback: NodeJS.Timeout | null = null;
      let exitDrainTimeout: NodeJS.Timeout | null = null;
      let completedSession: CompletedSession | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
        if (timeoutFallback) clearTimeout(timeoutFallback);
        if (exitDrainTimeout) clearTimeout(exitDrainTimeout);

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      // Now that resolveOnce exists, route process errors into it: an error after
      // a successful spawn means the process is gone, so the caller must not sit
      // waiting for output that will never arrive.
      forwardProcessError = (err: Error) => {
        session.lifecycleVersion++;
        if (this.sessions.get(session.pid) === session) this.sessions.delete(session.pid);
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output: output + `\nProcess error: ${err.message}`,
          isBlocked: false
        });
      };
      // An error emitted between spawn and here (the common case — spawn errors
      // land on the next tick) is replayed rather than dropped.
      if (pendingProcessError) {
        forwardProcessError(pendingProcessError);
      }

      childProcess.stdout.on('data', (data: any) => {
        // PID reuse or completed-session eviction must not retain late output.
        if (completedSession && this.completedSessions.get(session.pid) !== completedSession) return;
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        // `output` only feeds the wait-phase result and prompt/state detection,
        // so stop growing it once resolved and keep only a bounded tail.
        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(completedSession ?? session, text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (!completedSession && quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

      childProcess.stderr.on('data', (data: any) => {
        if (completedSession && this.completedSessions.get(session.pid) !== completedSession) return;
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (!resolved) {
          output += text;
          if (output.length > MAX_WAIT_OUTPUT_CHARS) {
            output = output.slice(-Math.floor(MAX_WAIT_OUTPUT_CHARS / 2));
          }
        }
        // Append to line-based buffer
        this.appendToLineBuffer(completedSession ?? session, text);

        // Record output event if collecting timing
        if (collectTiming) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic comprehensive check every 100ms
      if (!resolved) periodicCheck = setInterval(() => {
        if (output.trim()) {
          const processState = analyzeProcessState(output, childProcess.pid);
          if (processState.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({
              pid: childProcess.pid!,
              output,
              isBlocked: true
            });
          }
        }
      }, 100);
      // Allow the process to exit cleanly even when this interval is pending.
      periodicCheck?.unref();

      // Timeout fallback
      if (!resolved) timeoutFallback = setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      const completeSession = (code: number | null) => {
        if (!completedSession && (this.sessions.get(session.pid) === session ||
            (!this.sessions.has(session.pid) && !this.completedSessions.has(session.pid)))) {
          session.lifecycleVersion++;
          completedSession = {
            pid: session.pid,
            outputLines: [...session.outputLines], // Copy line buffer
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars,
            lastReadIndex: session.lastReadIndex,
            lastReadCharacter: session.lastReadCharacter,
            generation: session.generation,
            outputVersion: session.outputVersion,
            lifecycleVersion: session.lifecycleVersion,
            bufferedChars: session.bufferedChars,
            outputClosed: false,
            outputError: session.outputError,
          };
          this.completedSessions.set(session.pid, completedSession);

          // Bound total completed retention even when inherited pipes never close.
          this.pruneCompletedSessions();
          // The completed record owns the copied output now. Do not keep a second
          // 50 MiB buffer alive through child-event closures awaiting pipe close.
          session.outputLines.length = 0;
          session.bufferedChars = 0;

          this.sessions.delete(session.pid);
        }
      };
      const resolveExit = () => {
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      };
      // Descendants can retain inherited pipes after this PID exits. Keep draining
      // into its completed buffer, but bound the initial wait for stdio close.
      childProcess.on('exit', (code: number | null) => {
        completeSession(code);
        if (periodicCheck) clearInterval(periodicCheck);
        if (timeoutFallback) clearTimeout(timeoutFallback);
        if (!resolved) exitDrainTimeout = setTimeout(resolveExit, 100);
      });
      childProcess.on('close', (code: number | null) => {
        completeSession(code);
        if (completedSession && !completedSession.outputClosed) {
          completedSession.outputClosed = true;
          completedSession.lifecycleVersion++;
          this.pruneCompletedSessions();
        }
        resolveExit();
      });
    });
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: VersionedTerminalSession | CompletedSession, text: string): void {
    if (!text) return;
    session.outputVersion++;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Enforce the per-session cap by evicting the oldest lines. Keeps the
    // buffer far below V8's max string length so concatenation and join()
    // can never throw "Invalid string length" and kill the server.
    // Count them first and drop them with one splice: on an array this large
    // every shift() copies the whole array, and a line-by-line shift() stalled
    // the event loop for seconds per chunk once a session reached the cap.
    let evicted = 0;
    while (session.bufferedChars > MAX_BUFFERED_OUTPUT_CHARS && evicted < session.outputLines.length - 1) {
      const droppedJoinedChars = session.outputLines[evicted].length + 1; // +1 for its join separator
      session.bufferedChars -= droppedJoinedChars;
      session.evictedChars += droppedJoinedChars;
      evicted++;
    }
    if (evicted > 0) {
      session.outputLines.splice(0, evicted);
      session.evictedLines += evicted;
      if (evicted > session.lastReadIndex) session.lastReadCharacter = 0;
      session.lastReadIndex = Math.max(0, session.lastReadIndex - evicted);
    }
  }

  getProcessStatus(pid: number): { isComplete: boolean; exitCode: number | null; outputClosed: boolean } | null {
    if (this.sessions.has(pid)) return { isComplete: false, exitCode: null, outputClosed: false };
    const completed = this.completedSessions.get(pid);
    return completed ? { isComplete: true, exitCode: completed.exitCode, outputClosed: completed.outputClosed } : null;
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param characterOffset Explicit position within a line
   * @param options Optional budget override via maxBytes/pageSize or raw number
   */
  readOutputPaginated(
    pid: number,
    offset: number = 0,
    length: number = 1000,
    characterOffset?: number,
    options?: ReadOutputOptions | number
  ): PaginatedOutputResult | null {
    const overrideBudget = typeof options === 'number'
      ? options
      : (options?.maxBytes ?? options?.pageSize);
    const effectiveBudget = Math.min(
      overrideBudget !== undefined ? Math.max(512, overrideBudget) : DEFAULT_PROCESS_PAGE_BYTES,
      // Leave room for the read tool's status, cursor, eviction warning, timing,
      // and MCP envelope. The final limiter must never discard consumed output.
      MAX_TOOL_RESPONSE_BYTES - 2048
    );

    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        session.lastReadIndex,
        (newIndex, character) => { session.lastReadIndex = newIndex; session.lastReadCharacter = character; },
        false,
        undefined,
        undefined,
        session.lastReadCharacter ?? 0,
        characterOffset,
        effectiveBudget
      );
      result.evictedLines = session.evictedLines;
      result.outputError = session.outputError;
      return result;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        completedSession.lastReadIndex,
        (newIndex, character) => { completedSession.lastReadIndex = newIndex; completedSession.lastReadCharacter = character; },
        true,
        completedSession.exitCode,
        runtimeMs,
        completedSession.lastReadCharacter ?? 0,
        characterOffset,
        effectiveBudget,
        completedSession.outputClosed !== false
      );
      result.evictedLines = completedSession.evictedLines;
      result.outputError = completedSession.outputError;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number, character: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number,
    lastReadCharacter: number = 0,
    characterOffset?: number,
    effectiveBudget: number = DEFAULT_PROCESS_PAGE_BYTES,
    outputClosed: boolean = isComplete
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput)
      startIndex = characterOffset === undefined ? lastReadIndex : 0;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Update lastReadIndex for "new output" behavior
      // Advance only by the bounded page actually returned below.
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const page: string[] = [];
    let nextOffset = startIndex;
    let nextCharacterOffset = characterOffset ?? (offset === 0 ? lastReadCharacter : 0);
    // Count JSON-serialized text, including quotes and escaped separators.
    // Raw UTF-8 undercounts control characters (e.g. NUL becomes six bytes).
    let budget = effectiveBudget - 2;
    let sizeLimited = false;
    for (const line of linesToRead) {
      const unread = line.slice(nextCharacterOffset);
      if (unread.length === 0 && !outputClosed && nextOffset === totalLines - 1) break;
      const separatorBytes = page.length > 0 ? 2 : 0;
      const unreadBytes = serializedBytes(unread) - 2;
      if (unreadBytes + separatorBytes <= budget) {
        page.push(unread);
        budget -= unreadBytes + separatorBytes;
        nextOffset++;
        nextCharacterOffset = 0;
        if (budget < 8 && nextOffset < startIndex + linesToRead.length) { sizeLimited = true; break; }
      } else {
        // Use the rest of the page for the next line, recording its character
        // cursor. Refusing a partial subsequent line wastes almost a full line
        // per page and inflates call counts for regularly sized output.
        const piece = boundedText(unread, budget - separatorBytes + 2);
        if (piece.length === 0 && unread.length > 0) { sizeLimited = true; break; }
        page.push(piece);
        budget -= serializedBytes(piece) - 2 + separatorBytes;
        if (piece.length < unread.length) {
          nextCharacterOffset += piece.length;
          sizeLimited = true;
          break;
        }
        nextOffset++;
        nextCharacterOffset = 0;
        break;
      }
    }
    linesToRead = page;
    // Until stdio closes, the final line can still grow after the PID exits.
    if (!outputClosed && nextOffset === totalLines && totalLines > 0) {
      nextOffset = totalLines - 1;
      nextCharacterOffset = lines[nextOffset].length;
    }
    if (offset === 0 && characterOffset === undefined) updateLastRead(nextOffset, nextCharacterOffset);
    const readCount = linesToRead.length;
    const endIndex = nextOffset;
    const remaining = Math.max(0, totalLines - endIndex -
      (!outputClosed && endIndex === totalLines - 1 && nextCharacterOffset === lines[endIndex]?.length ? 1 : 0));

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs,
      nextOffset,
      nextCharacterOffset,
      sizeLimited
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  hasUnreadOutput(pid: number): boolean {
    const session = this.sessions.get(pid) ?? this.completedSessions.get(pid);
    if (!session) return false;
    return session.outputLines.length > session.lastReadIndex + 1 ||
      (session.outputLines[session.lastReadIndex]?.length ?? 0) > (session.lastReadCharacter ?? 0);
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    if (result.sizeLimited) {
      return `${output}\n\n[Size-limited output. Continue with read_process_output offset=${result.nextOffset}, character_offset=${result.nextCharacterOffset}.]`;
    }

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number; generation: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      return {
        // The buffer already accounts for embedded line separators.
        // No 50 MiB join is needed just to capture a cursor.
        totalChars: session.evictedChars + session.bufferedChars,
        lineCount: session.evictedLines + session.outputLines.length,
        generation: session.generation
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number; generation: number }): string | null {
    return this.readOutputSince(pid, snapshot)?.output ?? null;
  }

  /** Read only bytes appended after a cursor and return its exact next cursor.
   * A completed-session transfer preserves the absolute char offset. */
  readOutputSince(pid: number, cursor: { totalChars: number; lineCount: number; generation: number }): {
    output: string; next: { totalChars: number; lineCount: number; generation: number };
  } | null {
    const session = this.sessions.get(pid) ?? this.completedSessions.get(pid);
    // PID reuse must never let an old interaction read a replacement process.
    if (!session || session.generation !== cursor.generation) return null;
    return {
      output: TerminalManager.outputSinceSnapshot(
        session.outputLines, session.evictedChars, session.bufferedChars, cursor.totalChars
      ),
      next: {
        totalChars: session.evictedChars + session.bufferedChars,
        lineCount: session.evictedLines + session.outputLines.length,
        generation: session.generation
      }
    };
  }

  /**
   * New output since a snapshot, in absolute (since process start) offsets.
   * If eviction dropped part of the unseen output, returns what the buffer
   * still holds — the oldest unseen chars are lost to the cap.
   */
  private static outputSinceSnapshot(outputLines: string[], evictedChars: number, bufferedChars: number, snapshotTotalChars: number): string {
    // Most polls arrive with no output. The exact counter avoids rebuilding
    // the entire retained buffer on every poll and preserves absolute cursors.
    let remaining = Math.min(bufferedChars, evictedChars + bufferedChars - snapshotTotalChars);
    if (remaining <= 0) return '';
    const fragments: string[] = [];
    // Copy only the suffix newer than the snapshot, walking from the tail.
    // Separators between retained lines count as one character.
    for (let i = outputLines.length - 1; i >= 0 && remaining > 0; i--) {
      const line = outputLines[i];
      const take = Math.min(remaining, line.length);
      if (take > 0) fragments.push(line.slice(line.length - take));
      remaining -= take;
      if (remaining > 0 && i > 0) {
        fragments.push('\n');
        remaining--;
      }
    }
    return fragments.reverse().join('');
  }

  /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): VersionedTerminalSession | undefined {
    return this.sessions.get(pid);
  }

  /**
   * Get the current state version of a session (active or completed).
   * Strict key: (pid, generation, lifecycleVersion, outputVersion, lastReadIndex, lastReadCharacter)
   */
  getSessionStateVersion(pid: number): SessionStateVersion | null {
    const session = this.sessions.get(pid);
    if (session) {
      return {
        pid,
        generation: session.generation,
        lifecycleVersion: session.lifecycleVersion,
        outputVersion: session.outputVersion,
        lastReadIndex: session.lastReadIndex,
        lastReadCharacter: session.lastReadCharacter ?? 0,
      };
    }
    const completed = this.completedSessions.get(pid);
    if (completed) {
      return {
        pid,
        generation: completed.generation,
        lifecycleVersion: completed.lifecycleVersion,
        outputVersion: completed.outputVersion,
        lastReadIndex: completed.lastReadIndex,
        lastReadCharacter: completed.lastReadCharacter ?? 0,
      };
    }
    return null;
  }

  /**
   * Get a stable state key string for coalescing and suppression checks.
   */
  getSessionStateKey(pid: number): string | null {
    const v = this.getSessionStateVersion(pid);
    if (!v) return null;
    return `${v.pid}:${v.generation}:${v.lifecycleVersion}:${v.outputVersion}:${v.lastReadIndex}:${v.lastReadCharacter}`;
  }

  /** Await termination of a managed shell and the processes it started. */
  async forceTerminateAndWait(pid: number): Promise<'ended' | 'failed' | 'not_found'> {
    const session = this.sessions.get(pid);
    if (!session) return 'not_found';
    const ongoing = this.terminationInFlight.get(session);
    if (ongoing) return ongoing;
    session.lifecycleVersion++;
    const attempt = (async (): Promise<'ended' | 'failed'> => {
      try {
        return (await terminateProcessTree(session.process)) ? 'ended' : 'failed';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capture('server_request_error', { error: message, message: `Failed to terminate process tree ${pid}` });
        return 'failed';
      }
    })();
    this.terminationInFlight.set(session, attempt);
    try {
      return await attempt;
    } finally {
      // Never cache a failed result, and permit later retries if a tree survived.
      if (this.terminationInFlight.get(session) === attempt) this.terminationInFlight.delete(session);
    }
  }

  /** Backward-compatible initiation API used by internal session cleanup. */
  forceTerminate(pid: number): boolean {
    if (!this.sessions.has(pid)) return false;
    void this.forceTerminateAndWait(pid).then((result) => {
      if (result === 'failed') {
        capture('server_request_error', { error: 'Process tree termination failed', message: `PID ${pid}` });
      }
    });
    return true;
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}

export const terminalManager = new TerminalManager();
