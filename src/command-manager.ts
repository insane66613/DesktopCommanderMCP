import path from 'path';
import {configManager} from './config-manager.js';
import {capture} from "./utils/capture.js";

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
        const normalized = command.replace(/[`^]/g, '');
        return this.extractCommands(normalized).some(
            (candidate) => candidate === 'powershell' || candidate === 'powershell.exe'
        );
    }

    extractCommands(commandString: string): string[] {
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
                    let openParens = 1;
                    let j = i + 2; // skip past $(
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }
                    if (j <= commandString.length && openParens === 0) {
                        const subContent = commandString.substring(i + 2, j - 1);
                        const subCommands = this.extractCommands(subContent);
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
                    while (j < commandString.length && commandString[j] !== '`') {
                        j++;
                    }
                    if (j < commandString.length) {
                        const subContent = commandString.substring(i + 1, j);
                        const subCommands = this.extractCommands(subContent);
                        commands.push(...subCommands);
                        i = j;
                        if (!inQuote) {
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
                    let openParens = 1;
                    let j = i + 1;
                    while (j < commandString.length && openParens > 0) {
                        if (commandString[j] === '(') openParens++;
                        if (commandString[j] === ')') openParens--;
                        j++;
                    }

                    // Skip to after the closing parenthesis only if properly balanced
                    if (j <= commandString.length && openParens === 0) {
                        const subshellContent = commandString.substring(i + 1, j - 1);
                        // Recursively extract commands from the subshell
                        const subCommands = this.extractCommands(subshellContent);
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
                            commands.push(...this.extractSegmentCommands(currentCmd.trim()));
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
                commands.push(...this.extractSegmentCommands(currentCmd.trim()));
            }

            // Remove duplicates and return
            return [...new Set(commands)];
        } catch (error) {
            // If anything goes wrong, log the error but return the basic command to not break execution
            capture('server_request_error', {
                error: 'Error extracting commands'
            });
            const baseCmd = this.extractBaseCommand(commandString);
            return baseCmd ? [baseCmd] : [];
        }
    }

    private extractSegmentCommands(commandStr: string): string[] {
        const baseCommand = this.extractBaseCommand(commandStr);
        if (!baseCommand) return [];

        const commands = [baseCommand];
        if (process.platform !== 'win32') return commands;

        const nestedCommand = this.extractNestedWindowsShellCommand(commandStr, baseCommand);
        if (nestedCommand) {
            commands.push(...this.extractCommands(nestedCommand));
        }

        return commands;
    }

    private extractNestedWindowsShellCommand(commandStr: string, baseCommand: string): string | null {
        const cmdWrappers = new Set(['cmd', 'cmd.exe']);
        const pwshWrappers = new Set(['pwsh', 'pwsh.exe']);
        if (!cmdWrappers.has(baseCommand) && !pwshWrappers.has(baseCommand)) {
            return null;
        }

        const withoutEnvVars = commandStr.replace(/\w+=\S+\s*/g, '').trim();
        const withoutInvocationOperator = withoutEnvVars.replace(/^&\s*/, '').trim();
        const tokens = withoutInvocationOperator.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
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

        return nestedCommand || null;
    }

    // This extracts the actual command name from a command string
    extractBaseCommand(commandStr: string): string | null {
        try {
            // Remove environment variables (patterns like KEY=value)
            const withoutEnvVars = commandStr.replace(/\w+=\S+\s*/g, '').trim();

            // If nothing remains after removing env vars, return null
            if (!withoutEnvVars) return null;

            // Tokenize while preserving quoted executable paths (for example
            // & 'C:\\Windows\\...\\powershell.exe'). Strip the PowerShell
            // invocation operator before identifying the executable.
            const withoutInvocationOperator = withoutEnvVars.replace(/^&\s*/, '').trim();
            const tokens = withoutInvocationOperator.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
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
            const normalizedToken = firstToken.replace(/^['"]|['"]$/g, '');
            const baseName = path.basename(normalizedToken);
            return baseName.toLowerCase();
        } catch (error) {
            capture('Error extracting base command');
            return null;
        }
    }

    private splitExecutableSegments(commandString: string): string[] {
        const segments: string[] = [];
        let current = '';
        let quote: '"' | "'" | null = null;

        for (let i = 0; i < commandString.length; i++) {
            const char = commandString[i];
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

    getUnsafeInlineInterpreterReason(command: string): string | null {
        for (const segment of this.splitExecutableSegments(command)) {
            const withoutEnvVars = segment.replace(/\w+=\S+\s*/g, '').trim();
            const normalized = withoutEnvVars.replace(/^&\s*/, '').trim();
            const tokens = normalized.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
            const executableToken = tokens[0];
            if (!executableToken) continue;

            const executable = path.basename(executableToken.replace(/^['"]|['"]$/g, '')).toLowerCase();
            const args = tokens.slice(1).map((token) => token.replace(/^['"]|['"]$/g, ''));

            if (['python', 'python.exe', 'python3', 'python3.exe', 'py', 'py.exe'].includes(executable)) {
                const inlineSwitch = args.find((arg) => arg === '-c' || /^-c.+/.test(arg));
                if (inlineSwitch) return `inline interpreter invocation ${executable} ${inlineSwitch}`;
            }

            if (['node', 'node.exe'].includes(executable)) {
                const inlineSwitch = args.find((arg) =>
                    arg === '-e' || arg === '--eval' || arg.startsWith('--eval=') || /^-e.+/.test(arg) ||
                    arg === '-p' || arg === '--print' || arg.startsWith('--print=') || /^-p.+/.test(arg)
                );
                if (inlineSwitch) return `inline interpreter invocation ${executable} ${inlineSwitch}`;
            }

            if (process.platform === 'win32' && ['cmd', 'cmd.exe', 'pwsh', 'pwsh.exe'].includes(executable)) {
                const nested = this.extractNestedWindowsShellCommand(segment, executable);
                if (nested) {
                    const nestedReason = this.getUnsafeInlineInterpreterReason(nested);
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
