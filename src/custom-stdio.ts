import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { format } from 'node:util';

type LogLevel = 'debug' | 'info' | 'notice' | 'warning' | 'error' | 'critical' | 'alert' | 'emergency';
const LOG_LEVELS: LogLevel[] = ['debug', 'info', 'notice', 'warning', 'error', 'critical', 'alert', 'emergency'];

/** Keep diagnostics local; clients explicitly opt into protocol logging/setLevel. */
export class FilteredStdioServerTransport extends StdioServerTransport {
  private originalConsole = {
    log: console.log, warn: console.warn, error: console.error,
    debug: console.debug, info: console.info,
  };
  private originalStdoutWrite = process.stdout.write;
  private isInitialized = false;
  private disableNotifications = false;
  private minimumLogLevel: LogLevel | undefined;

  constructor() {
    super();
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      console[method] = (...args: unknown[]) => this.localDiagnostic(args);
    }
    process.stdout.write = (buffer: any, encoding?: any, callback?: any): boolean => {
      const text = typeof buffer === 'string' ? buffer : buffer instanceof Uint8Array
        ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength).toString('utf8') : '';
      const lines = text.trim().split('\n').filter(Boolean);
      const protocol = lines.length > 0 && lines.every(line => {
        try {
          const value = JSON.parse(line);
          return value?.jsonrpc === '2.0' && ('id' in value || typeof value.method === 'string');
        } catch { return false; }
      });
      if (protocol || text.length === 0) {
        return this.originalStdoutWrite.call(process.stdout, buffer, encoding, callback);
      }
      this.localDiagnostic([text.trimEnd()]);
      const done = typeof encoding === 'function' ? encoding : callback;
      if (typeof done === 'function') process.nextTick(done);
      return true;
    };
  }

  private localDiagnostic(args: unknown[]): void {
    try {
      process.stderr.write(format(...args).slice(0, 4096) + '\n');
    } catch {
      process.stderr.write('[Desktop Commander diagnostic unavailable]\n');
    }
  }

  public enableNotifications(): void { this.isInitialized = true; }

  public configureForClient(clientName: string): void {
    const name = clientName.toLowerCase();
    this.disableNotifications = name.includes('cline') || name.includes('vscode') || name === 'claude-dev';
  }

  public setLogLevel(level: LogLevel): void { this.minimumLogLevel = level; }
  public get isNotificationsEnabled(): boolean { return this.isInitialized; }
  public get bufferedMessageCount(): number { return 0; }

  public sendLog(level: LogLevel, message: string, data?: any): void {
    this.localDiagnostic(data === undefined ? [message] : [message, data]);
    if (!this.isInitialized || this.disableNotifications || this.minimumLogLevel === undefined ||
        LOG_LEVELS.indexOf(level) < LOG_LEVELS.indexOf(this.minimumLogLevel)) return;
    // No replay, payload dumps or unbounded log messages on the MCP channel.
    this.sendCustomNotification('notifications/message', {
      level, logger: 'desktop-commander', data: message.slice(0, 4096),
    });
  }

  public sendProgress(token: string, value: number, total?: number): void {
    this.sendCustomNotification('notifications/progress', {
      progressToken: token, value, ...(total !== undefined ? { total } : {}),
    });
  }

  public sendCustomNotification(method: string, params: any): void {
    if (!this.isInitialized) return;
    try {
      this.originalStdoutWrite.call(process.stdout, JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    } catch {
      this.localDiagnostic(['Desktop Commander notification serialization failed']);
    }
  }

  public cleanup(): void {
    Object.assign(console, this.originalConsole);
    process.stdout.write = this.originalStdoutWrite;
  }
}
