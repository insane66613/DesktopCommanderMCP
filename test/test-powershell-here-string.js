import assert from 'node:assert';
import { commandManager } from '../dist/command-manager.js';

console.log('Testing PowerShell here-string command extraction (Issue #731)...');

// Test 1: Single-quoted here-string containing apostrophe and C++ int32(Format)
const testCase1 = `$code = @'
# It's a test script with apostrophes
class Inspector {
    void Inspect() {
        int32(Format);
    }
};
'@
python -c $code`;

const commands1 = commandManager.extractCommands(testCase1);
console.log('Test 1 extracted commands:', commands1);
assert(!commands1.includes('format'), 'Should not extract "format" from inside single-quoted here-string');
assert(!commands1.includes('Format'), 'Should not extract "Format" from inside single-quoted here-string');

// Test 2: Single-quoted here-string with Windows CRLF line endings
const testCase2 = `$code = @'\r\n# It's a test\r\nint32(Format);\r\n'@\r\npython -c $code`;
const commands2 = commandManager.extractCommands(testCase2);
console.log('Test 2 extracted commands:', commands2);
assert(!commands2.includes('format'), 'Should not extract "format" with CRLF here-string delimiters');

// Test 3: Double-quoted here-string with $() subshell should extract the inner command
const testCase3 = `$msg = @"
Header line
$(whoami)
Footer line
"@`;
const commands3 = commandManager.extractCommands(testCase3);
console.log('Test 3 extracted commands:', commands3);
assert(commands3.includes('whoami'), 'Should extract command inside $() in double-quoted here-string');

// Test 4: Verify validateCommand does not block safe commands containing Format inside here-string
const testCase4 = `$code = @'
# It's a test script with apostrophes
int32(Format);
'@`;
// "format" is in default blocked commands
const isValid = await commandManager.validateCommand(testCase4);
console.log('Test 4 validateCommand result (expected true):', isValid);
assert.strictEqual(isValid, true, 'Command containing Format inside here-string should be valid and not blocked');

// Test 5: Backtick-escaped subshell expressions should not be extracted
const escapedSubshell = '@"\n`$(format C:)\n"@';
const escapedCommands = commandManager.extractCommands(escapedSubshell);
assert.ok(!escapedCommands.includes('format'), 'Backtick-escaped $(format) should not be extracted');

// Test 6: Subshell expression with quoted parenthesis should properly extract command
const quotedParenSubshell = "@\"\n$(Write-Output ')' ; format C:)\n\"@";
const quotedParenCommands = commandManager.extractCommands(quotedParenSubshell);
assert.ok(quotedParenCommands.includes('format'), 'format command should be extracted even with quoted parenthesis inside subshell');

// Test 7: Statement terminator newline after here-string should split independent commands
const statementTerminatorCmd = "$code = @'\ntext\n'@\nformat C:";
const terminatorCommands = commandManager.extractCommands(statementTerminatorCmd);
assert.ok(terminatorCommands.includes('format'), 'format command following here-string after newline should be extracted independently');

console.log('All PowerShell here-string tests passed successfully!');

for (const command of ["echo $(echo ')'; format C:)", "echo (echo '('; format C:)"]) {
    assert.ok(commandManager.extractCommands(command).includes('format'), 'Quoted parentheses must not hide later executable commands');
}
if (process.platform === 'win32') {
    for (const ending of ['', '\n']) {
        const executableHere = "pwsh -NoProfile -Command @'\nformat C:\n'@" + ending;
        assert.ok(commandManager.extractCommands(executableHere).includes('format'), 'PowerShell -Command executes its here-string argument');
        assert.match(commandManager.getUnsafeInlineInterpreterReason("pwsh -Command @'\nnode -e 1\n'@"), /inline interpreter/i);
    }
}

assert.strictEqual(await commandManager.validateCommand('@"\n`$(powershell.exe)\n"@'), true,
    'Legacy shell normalization must preserve escaped inert expansions');
assert.ok(commandManager.extractCommands('@"\n``$(format C:)\n"@').includes('format'),
    'An even number of backticks leaves an executable expansion');
assert.ok(commandManager.extractCommands("@'\nformat C:\n'@; format C:").includes('format'),
    'A separator following the closing delimiter continues command parsing');
const deepExpansion = '@"\n' + '$('.repeat(25) + 'format C:' + ')'.repeat(25) + '\n"@';
assert.strictEqual(await commandManager.validateCommand(deepExpansion), false,
    'Here-string expansion recursion must fail closed');
const inertInline = "$code = @'\nIt's inert source\npython -c \"print(1)\"\n'@";
assert.strictEqual(commandManager.getUnsafeInlineInterpreterReason(inertInline), null,
    'Inline guard must skip inert here-string source containing apostrophes');
assert.match(commandManager.getUnsafeInlineInterpreterReason(inertInline + '\nnode -e "1"'), /inline interpreter/i,
    'Inline guard must still inspect the statement following the here-string');

