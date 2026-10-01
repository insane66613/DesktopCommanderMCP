import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";

class CommandParsingLimitError extends Error {}

const MAX_RECURSION_DEPTH = 20;
const ENV_ASSIGNMENT_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*=/;

function tokenizeRespectingQuotes(str: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    let quoteChar = '';
    let escaped = false;

    for (const ch of str) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }
        if (ch === (process.platform === 'win32' ? '`' : '\\')) {
            escaped = true;
            current += ch;
            continue;
        }
        if ((ch === '"' || ch === "'") && (!inQuote || ch === quoteChar)) {
            inQuote = !inQuote;
            quoteChar = inQuote ? ch : '';
            current += ch;
            continue;
        }
        if (!inQuote && /\s/.test(ch)) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += ch;
    }
    if (current) tokens.push(current);
    return tokens;
}

class CommandManager {

    getBaseCommand(command: string) {
        return command.split(' ')[0].toLowerCase().trim();
    }

    isLegacyWindowsPowerShellInvocation(command: string): boolean {
        if (process.platform !== 'win32') return false;

        // Inspect executable positions only. A literal mention such as a Git
        // commit message containing "PowerShell" must not be treated as an
        // invocation. extractCommands() also descends into cmd/pwsh command
        // arguments so actual nested Windows PowerShell execution is denied.
        return this.extractCommands(command).some(
            (candidate) => ['powershell', 'powershell.exe'].includes(candidate.replace(/[`^]/g, ''))
        );
    }

    extractCommands(commandString: string, depth: number = 0): string[] {
        if (depth > MAX_RECURSION_DEPTH) {
            capture('command_parser_depth_exceeded', { depth });
            throw new CommandParsingLimitError('Command nesting depth exceeded maximum allowed limit');
        }
        try {
            // Trim any leading/trailing whitespace
            commandString = commandString.trim();

            // Define command separators - these are the operators that can chain commands
            const separators = [';', '&&', '||', '|', '&'];

            // This will store our extracted commands
            const commands: string[] = [];

            // Split by common separators while preserving quotes
            let inQuote = false;
            let quoteChar = '';
            let currentCmd = '';
            let escaped = false;

            for (let i = 0; i < commandString.length; i++) {
                const char = commandString[i];

                // Handle escape characters
                if (char === '\\' && !escaped) {
                    escaped = true;
                    currentCmd += char;
                    continue;
                }

                // If this character is escaped, just add it
                if (escaped) {
                    escaped = false;
                    currentCmd += char;
                    continue;
                }

                // Handle PowerShell here-strings: @"\r?\n or @'\r?\n
                if (!inQuote && char === '@' && (commandString[i + 1] === "'" || commandString[i + 1] === '"')) {
                    const hereQuote = commandString[i + 1];
                    const hereStartMatch = commandString.slice(i).match(/^@(['"])(\r?\n)/);
                    if (hereStartMatch) {
                        const searchStart = i + hereStartMatch[0].length;
                        const closePattern = new RegExp(`(?:\\r?\\n)${hereQuote}@`);
                        const closeMatch = commandString.slice(searchStart).match(closePattern);
                        if (closeMatch && closeMatch.index !== undefined) {
                            const fullHereEnd = searchStart + closeMatch.index + closeMatch[0].length;
                            const hereContent = commandString.substring(searchStart, searchStart + closeMatch.index);

                            // In double-quoted here-strings, PowerShell evaluates $() subshell expansions
                            if (hereQuote === '"') {
                                for (let k = 0; k < hereContent.length; k++) {
                                    if (hereContent[k] === '$' && hereContent[k + 1] === '(') {
                                        // Ignore backtick-escaped `$()` expressions
                                        let backtickCount = 0;
                                        let b = k - 1;
                                        while (b >= 0 && hereContent[b] === '`') {
                                            backtickCount++;
                                            b--;
                                        }
                                        if (backtickCount % 2 === 1) {
                                            continue;
                                        }

                                        const m = this.findClosingParenthesis(hereContent, k + 2);
                                        if (m >= 0) {
                                            const subContent = hereContent.substring(k + 2, m - 1);
                                            const subCommands = this.extractCommands(subContent, depth + 1);
                                            commands.push(...subCommands);
                                            k = m - 1;
                                        }
                                    }
                                }
                            }

                            currentCmd += commandString.substring(i, fullHereEnd);
                            const restAfterHere = commandString.slice(fullHereEnd);
                            const newlineMatch = restAfterHere.match(/^(\r?\n)+/);
                            if (newlineMatch) {
                                if (currentCmd.trim()) {
                                    commands.push(...this.extractSegmentCommands(currentCmd.trim(), depth));
                                }
                                currentCmd = '';
                                i = fullHereEnd + newlineMatch[0].length - 1;
                            } else {
                                i = fullHereEnd - 1;
                            }
                            continue;
                        }
                    }
                }

                // Handle quotes (both single and double)
                if ((char === '"' || char === "'") && !inQuote) {
                    inQuote = true;
                    quoteChar = char;
                    currentCmd += char;
                    continue;
                } else if (char === quoteChar && inQuote) {
                    inQuote = false;
                    quoteChar = '';
                    currentCmd += char;
                    continue;
                }

                // Handle $() command substitution even inside quotes (fixes blocklist bypass)
                if (char === '$' && i + 1 < commandString.length && commandString[i + 1] === '(') {
                    const startIndex = i;
                    const j = this.findClosingParenthesis(commandString, i + 2);
                    if (j >= 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent, depth + 1);
                        commands.push(...subCommands);
                        i = j - 1;
                        if (!inQuote) {
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j);
                            continue;
                        }
                    }
                }

                // Handle backtick command substitution even inside quotes
                if (char === '`') {
                    const startIndex = i;
                    let j = i + 1;
                    let backtickEscaped = false;
                    while (j < commandString.length) {
                        const current = commandString[j];
                        if (backtickEscaped) {
                            backtickEscaped = false;
                            j++;
                            continue;
                        }
                        if (current === '\\') {
                            backtickEscaped = true;
                            j++;
                            continue;
                        }
                        if (current === '`') break;
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent, depth + 1);
                        commands.push(...subCommands);
                        i = j;
                        if (!inQuote) {
                            // PowerShell backticks escape characters in executable names.
                            // Retain the token while conservatively checking Unix substitution too.
                            if (process.platform === 'win32') currentCmd += commandString.substring(startIndex, j + 1);
                            continue;
                        } else {
                            currentCmd += commandString.substring(startIndex, j + 1);
                            continue;
                        }
                    }
                }

                // If we're inside quotes, just add the character
                if (inQuote) {
                    currentCmd += char;
                    continue;
                }

                // Handle subshells - if we see an opening parenthesis, we need to find its matching closing parenthesis
                if (char === '(') {
                    // Find the matching closing parenthesis
                    const j = this.findClosingParenthesis(commandString, i + 1);
                    if (j >= 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        // Recursively extract commands from the subshell
                        const subCommands = this.extractCommands(subshellContent, depth + 1);
                        commands.push(...subCommands);

                        // Move position past the subshell
                        i = j - 1;
                        continue;
                    }
                }

                // Check for separators
                let isSeparator = false;
                for (const separator of separators) {
                    if (commandString.startsWith(separator, i)) {
                        // We found a separator - extract the command before it
                        if (currentCmd.trim()) {
                            commands.push(...this.extractSegmentCommands(currentCmd.trim(), depth));
                        }

                        // Move past the separator
                        i += separator.length - 1;
                        currentCmd = '';
                        isSeparator = true;
                        break;
                    }
                }

                if (!isSeparator) {
                    currentCmd += char;
                }
            }

            // Don't forget to add the last command
            if (currentCmd.trim()) {
                commands.push(...this.extractSegmentCommands(currentCmd.trim(), depth));
            }

            // Remove duplicates and return
            return [...new Set(commands)];
        } catch (error) {
            if (error instanceof CommandParsingLimitError) {
                throw error;
            }
            // If anything goes wrong, log the error but return the basic command to not break execution
            capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString);
            return baseCmd ? [baseCmd] : [];
        }
    }

    private findClosingParenthesis(source: string, start: number): number {
        let depth = 1;
        let quote = '';
        for (let i = start; i < source.length; i++) {
            const char = source[i];
            if (char === '\\' || char === '`') { i++; continue; }
            if (quote) {
                if (char === quote) {
                    if (source[i + 1] === quote) i++;
                    else quote = '';
                }
            } else if (char === '"' || char === "'") quote = char;
            else if (char === '(') depth++;
            else if (char === ')' && --depth === 0) return i + 1;
        }
        return -1;
    }

    private extractSegmentCommands(commandStr: string, depth: number): string[] {
        const baseCommand = this.extractBaseCommand(commandStr);
        if (!baseCommand) return [];

        const commands = [baseCommand];
        if (process.platform !== 'win32') return commands;

        const nestedCommand = this.extractNestedWindowsShellCommand(commandStr, baseCommand);
        if (nestedCommand) {
            commands.push(...this.extractCommands(nestedCommand, depth + 1));
        }

        return commands;
    }

    private extractNestedWindowsShellCommand(commandStr: string, baseCommand: string): string | null {
        const cmdWrappers = new Set(['cmd', 'cmd.exe']);
        const pwshWrappers = new Set(['pwsh', 'pwsh.exe']);
        if (!cmdWrappers.has(baseCommand) && !pwshWrappers.has(baseCommand)) {
            return null;
        }

        const tokens = this.executableTokens(commandStr);
        if (tokens.length < 2) return null;

        const commandSwitches = cmdWrappers.has(baseCommand)
            ? new Set(['/c', '/k'])
            : new Set(['-command', '-c', '-commandwithargs']);
        const switchIndex = tokens.findIndex((token, index) => {
            if (index === 0) return false;
            return commandSwitches.has(token.replace(/^['"]|['"]$/g, '').toLowerCase());
        });
        if (switchIndex < 0 || switchIndex + 1 >= tokens.length) return null;

        let nestedCommand = tokens.slice(switchIndex + 1).join(' ').trim();
        if (
            nestedCommand.length >= 2 &&
            ((nestedCommand.startsWith('"') && nestedCommand.endsWith('"')) ||
             (nestedCommand.startsWith("'") && nestedCommand.endsWith("'")))
        ) {
            nestedCommand = nestedCommand.slice(1, -1).trim();
        }

        const hereString = nestedCommand.match(/^@(['"])\r?\n([\s\S]*?)\r?\n\1@$/);
        if (pwshWrappers.has(baseCommand) && hereString) nestedCommand = hereString[2].trim();
        return nestedCommand || null;
    }

    // This extracts the actual command name from a command string
    private executableTokens(commandStr: string): string[] {
        const tokens = tokenizeRespectingQuotes(commandStr.trim().replace(/^&\s*/, ''));
        let start = 0;
        while (start < tokens.length && (tokens[start] === 'export' || ENV_ASSIGNMENT_PATTERN.test(tokens[start]))) start++;
        return tokens.slice(start);
    }

    extractBaseCommand(commandStr: string): string | null {
        try {
            const tokens = this.executableTokens(commandStr);

            let firstToken = null;

            // Find the first valid token (skip variables)
            for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i];
                
                // Skip dollar-prefixed tokens (variables) but not $() command substitutions
                if (token.startsWith('$') && !token.startsWith('$(')) {
                    continue;
                }
                
                // Check if it starts with special characters like ( that might indicate it's not a regular command
                if (token[0] === '(') {
                    continue;
                }
                
                firstToken = token;
                break;
            }

            // No valid command token found
            if (!firstToken) {
                return null;
            }

            // handle $() command substitution - extract the inner command
            if (firstToken.startsWith('$(') && firstToken.endsWith(')')) {
                const inner = firstToken.slice(2, -1).trim();
                if (inner) {
                    const innerTokens = inner.split(/\s+/);
                    return path.basename(innerTokens[0]).toLowerCase();
                }
                return null;
            }

            // Strip surrounding quotes before normalizing the path basename so
            // quoted absolute executables are checked against the blocklist.
            let normalizedToken = firstToken.replace(/^['"]|['"]$/g, '');
            if (process.platform === 'win32') normalizedToken = normalizedToken.replace(/[`^]/g, '');
            const baseName = path.basename(normalizedToken);
            return baseName.toLowerCase();
        } catch (error) {
            capture('Error extracting base command');
            return null;
        }
    }

    private splitExecutableSegments(commandString: string, shell?: string): string[] {
        const segments: string[] = [];
        let current = '';
        let quote: '"' | "'" | null = null;
        let escaped = false;
        const shellName = (shell ?? (process.platform === 'win32' ? 'pwsh.exe' : '')).toLowerCase();
        const escapeChar = process.platform === 'win32'
            ? (shellName.includes('cmd') ? '^' : '`')
            : '\\';

        for (let i = 0; i < commandString.length; i++) {
            const char = commandString[i];
            if (escaped) {
                current += char;
                escaped = false;
                continue;
            }
            if (quote === null && char === '@') {
                const opening = commandString.slice(i).match(/^@(['"])(\r?\n)/);
                if (opening) {
                    const start = i + opening[0].length;
                    const closing = commandString.slice(start).match(new RegExp(`(?:^|\\r?\\n)${opening[1]}@`));
                    if (closing?.index !== undefined) {
                        const end = start + closing.index + closing[0].length;
                        current += commandString.slice(i, end);
                        i = end - 1;
                        continue;
                    }
                }
            }
            if (char === escapeChar) {
                const next = commandString[i + 1];
                if (next === '\r' || next === '\n') {
                    current += ' ';
                    if (next === '\r' && commandString[i + 2] === '\n') i += 2;
                    else i += 1;
                    continue;
                }
                current += char;
                escaped = true;
                continue;
            }
            if ((char === '"' || char === "'") && quote === null) {
                quote = char;
                current += char;
                continue;
            }
            if (char === quote) {
                quote = null;
                current += char;
                continue;
            }
            if (quote === null) {
                const separator = ['\r\n', '\n', '\r', '&&', '||', ';', '|', '&'].find((candidate) =>
                    commandString.startsWith(candidate, i)
                );
                if (separator) {
                    if (current.trim()) segments.push(current.trim());
                    current = '';
                    i += separator.length - 1;
                    continue;
                }
            }
            current += char;
        }

        if (current.trim()) segments.push(current.trim());
        return segments;
    }

    private findPythonInlineSwitch(args: string[]): string | null {
        const optionsWithValues = new Set(['-W', '-X', '--check-hash-based-pycs']);
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (!arg) continue;
            if (arg === '--') return null;
            if (arg === '-c' || /^-c.+/.test(arg)) return arg;
            if (arg === '-m' || /^-m.+/.test(arg)) return null;
            if (!arg.startsWith('-')) return null;
            if (optionsWithValues.has(arg)) i++;
        }
        return null;
    }

    private findNodeInlineSwitch(args: string[]): string | null {
        const optionsWithValues = new Set([
            '-r', '--require', '--loader', '--experimental-loader', '--import', '--conditions',
            '--input-type', '--inspect-port', '--openssl-config', '--icu-data-dir', '--title',
            '--stack-trace-limit', '--max-old-space-size', '--max-semi-space-size', '--env-file',
            '--env-file-if-exists', '--watch-path', '--test-name-pattern', '--test-reporter',
            '--test-reporter-destination', '--test-shard', '--test-timeout', '--redirect-warnings',
            '--diagnostic-dir', '--report-dir', '--report-filename', '--cpu-prof-dir', '--cpu-prof-name',
            '--heap-prof-dir', '--heap-prof-name', '--snapshot-blob',
        ]);
        for (let i = 0; i < args.length; i++) {
            const arg = args[i];
            if (!arg) continue;
            if (arg === '--') return null;
            if (
                arg === '-e' || arg === '--eval' || arg.startsWith('--eval=') || /^-e.+/.test(arg) ||
                arg === '-p' || arg === '--print' || arg.startsWith('--print=') || /^-p.+/.test(arg)
            ) return arg;
            if (!arg.startsWith('-')) return null;
            if (optionsWithValues.has(arg)) i++;
        }
        return null;
    }

    getUnsafeInlineInterpreterReason(command: string, shell?: string, depth: number = 0): string | null {
        if (depth > MAX_RECURSION_DEPTH) return 'inline interpreter shell nesting exceeds maximum allowed limit';
        for (const segment of this.splitExecutableSegments(command, shell)) {
            const tokens = this.executableTokens(segment);
            const executableToken = tokens[0];
            if (!executableToken) continue;

            const executable = path.basename(executableToken.replace(/^['"]|['"]$/g, '')).toLowerCase();
            const args = tokens.slice(1).map((token) => token.replace(/^['"]|['"]$/g, ''));

            if (['python', 'python.exe', 'python3', 'python3.exe', 'py', 'py.exe'].includes(executable)) {
                const inlineSwitch = this.findPythonInlineSwitch(args);
                if (inlineSwitch) return `inline interpreter invocation ${executable} ${inlineSwitch}`;
            }

            if (['node', 'node.exe'].includes(executable)) {
                const inlineSwitch = this.findNodeInlineSwitch(args);
                if (inlineSwitch) return `inline interpreter invocation ${executable} ${inlineSwitch}`;
            }

            if (process.platform === 'win32' && ['cmd', 'cmd.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
                const nested = this.extractNestedWindowsShellCommand(segment, executable);
                if (nested) {
                    const nestedReason = this.getUnsafeInlineInterpreterReason(nested, executable, depth + 1);
                    if (nestedReason) return nestedReason;
                }
            }
        }

        return null;
    }

    async validateCommand(command: string): Promise<boolean> {
        try {
            // Windows PowerShell 5.1 is not an allowed execution dependency.
            // Reject it independently of the configurable command blocklist so
            // quoted/full-path/nested invocations cannot downgrade the shell.
            if (this.isLegacyWindowsPowerShellInvocation(command)) {
                return false;
            }

            // Get blocked commands from config
            const config = await configManager.getConfig();
            const blockedCommands = config.blockedCommands || [];
            
            // Extract all commands from the command string
            const allCommands = this.extractCommands(command);
            
            // If there are no commands extracted, fall back to base command
            if (allCommands.length === 0) {
                const baseCommand = this.getBaseCommand(command);
                return !blockedCommands.includes(baseCommand);
            }
            
            // Check if any of the extracted commands are in the blocked list
            for (const cmd of allCommands) {
                if (blockedCommands.includes(cmd)) {
                    return false; // Command is blocked
                }
            }
            
            // No commands were blocked
            return true;
        } catch (error) {
            console.error('Error validating command:', error);
            capture('server_validate_command_error', {
                error: error instanceof Error ? error.message : String(error)
            });
            // Fail closed: deny the command if validation encounters an error.
            // This prevents a config read failure from bypassing all command filtering.
            return false;
        }
    }
}

export const commandManager = new CommandManager();
