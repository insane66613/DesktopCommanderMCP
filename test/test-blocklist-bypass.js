/**
 * Tests for command blocklist bypass fixes
 * Covers: absolute path bypass (#218), command substitution bypass (#217)
 */

import assert from 'assert';
import { commandManager } from '../dist/command-manager.js';
import { configManager } from '../dist/config-manager.js';
import { interactWithProcess } from '../dist/tools/improved-process-tools.js';
import { terminalManager } from '../dist/terminal-manager.js';

async function testInteractiveBlockedCommandValidation() {
    const originalConfig = await configManager.getConfig();
    await configManager.setValue('blockedCommands', ['rm']);

    const originalSend = terminalManager.sendInputToProcess;
    const originalSnapshot = terminalManager.captureOutputSnapshot;
    const inputs = [];
    terminalManager.sendInputToProcess = (_processId, input) => { inputs.push(input); return true; };
    terminalManager.captureOutputSnapshot = () => null;
    try {
        const result = await interactWithProcess({
            pid: 12345,
            input: 'rm',
            wait_for_prompt: false
        });
        assert.strictEqual(result.isError, true, 'Blocked interactive input should be rejected');
        assert.match(result.content[0].text, /blocked command/i, 'Blocked input should report the policy rejection');
        assert.deepStrictEqual(inputs, [], 'Blocked input must never reach stdin');
        const benign = await interactWithProcess({ pid: 12345, input: 'hello', wait_for_prompt: false });
        assert.notStrictEqual(benign.isError, true, 'Benign input should continue working');
        assert.deepStrictEqual(inputs, ['hello']);
    } finally {
        terminalManager.sendInputToProcess = originalSend;
        terminalManager.captureOutputSnapshot = originalSnapshot;
        await configManager.updateConfig(originalConfig);
    }
}

async function runTests() {
    // mock config with blocked commands
    const blockedCmds = ['sudo', 'iptables', 'rm'];

    console.log('Testing extractCommands...\n');

    try {
        // Test 1: absolute path should be normalized
        const cmds1 = commandManager.extractCommands('/usr/bin/sudo ls');
        console.log('  /usr/bin/sudo ls =>', cmds1);
        assert.ok(cmds1.includes('sudo'), 'FAIL: should extract "sudo" from absolute path');

        // Test 2: $() command substitution inside quotes
        const cmds2 = commandManager.extractCommands('echo "$(iptables -L)"');
        console.log('  echo "$(iptables -L)" =>', cmds2);
        assert.ok(cmds2.includes('iptables'), 'FAIL: should extract "iptables" from $() inside quotes');

        // Test 3: backtick substitution  
        const cmds3 = commandManager.extractCommands('echo `rm -rf /`');
        console.log('  echo `rm -rf /` =>', cmds3);
        assert.ok(cmds3.includes('rm'), 'FAIL: should extract "rm" from backticks');

        // Test 4: normal command still works
        const cmds4 = commandManager.extractCommands('ls -la /home');
        console.log('  ls -la /home =>', cmds4);
        assert.ok(cmds4.includes('ls'), 'FAIL: should extract "ls" normally');

        // Test 5: nested $() inside $()
        const cmds5 = commandManager.extractCommands('echo $(cat $(which sudo))');
        console.log('  echo $(cat $(which sudo)) =>', cmds5);
        assert.ok(cmds5.includes('cat'), 'FAIL: should extract "cat" from nested $()');

        // Test 6: path with env var prefix
        const cmds6 = commandManager.extractCommands('HOME=/tmp /usr/sbin/iptables');
        console.log('  HOME=/tmp /usr/sbin/iptables =>', cmds6);
        assert.ok(cmds6.includes('iptables'), 'FAIL: should extract "iptables" from path with env');

        // Test 7: backtick substitution inside quotes
        const cmds7 = commandManager.extractCommands('echo "`/usr/bin/sudo`"');
        console.log('  echo "`/usr/bin/sudo`" =>', cmds7);
        assert.ok(cmds7.includes('sudo'), 'FAIL: should extract "sudo" from backticks inside quotes');

        // Test 8: dollar-prefixed tokens should be ignored
        const cmds8 = commandManager.extractCommands('$MYVAR ls');
        console.log('  $MYVAR ls =>', cmds8);
        assert.ok(cmds8.includes('ls'), 'FAIL: should extract "ls" and ignore $MYVAR');
        assert.ok(!cmds8.includes('$MYVAR'), 'FAIL: should not include $MYVAR as a command');

        // Test 9: PowerShell invocation operator + quoted absolute path must normalize.
        const cmds9 = commandManager.extractCommands("& 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe' -NoProfile");
        console.log('  quoted Windows PowerShell path =>', cmds9);
        assert.ok(cmds9.includes('powershell.exe'), 'FAIL: should extract powershell.exe from quoted absolute path');

        // Test 10: hard legacy-PowerShell detector catches nested/full-path forms but not pwsh.
        assert.strictEqual(commandManager.isLegacyWindowsPowerShellInvocation("cmd /c C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoProfile"), true);
        assert.strictEqual(commandManager.isLegacyWindowsPowerShellInvocation('pwsh.exe -NoProfile'), false);

        // Test 11: export + env assignment must not mask the real command.
        const cmds11 = commandManager.extractCommands('export PATH=/usr/bin rm -rf /');
        assert.ok(cmds11.includes('rm'), 'FAIL: should extract rm past export/env prefixes');
        assert.ok(!cmds11.includes('export'), 'FAIL: export is a shell prefix, not the executed command');

        // Test 12: quoted env values containing spaces must remain one prefix token.
        const cmds12 = commandManager.extractCommands('FOO="a b" rm -rf /');
        assert.ok(cmds12.includes('rm'), 'FAIL: should extract rm past a quoted env assignment');

        // Test 13: multiple leading env assignments must all be skipped.
        const cmds13 = commandManager.extractCommands('A=1 B=2 rm -rf /');
        assert.ok(cmds13.includes('rm'), 'FAIL: should extract rm past multiple env assignments');

        // Test 14: ordinary nested substitutions must remain supported.
        const cmds14 = commandManager.extractCommands('$($($(rm -rf /)))');
        assert.ok(cmds14.includes('rm'), 'FAIL: should extract rm from reasonable nesting');

        // Test 15: pathological nesting must fail closed instead of exhausting recursion.
        const deeplyNested = '$('.repeat(25) + 'rm -rf /' + ')'.repeat(25);
        assert.throws(
            () => commandManager.extractCommands(deeplyNested),
            /nesting depth|maximum allowed limit/i,
            'FAIL: excessive nesting must throw a policy/parser limit error'
        );
        assert.strictEqual(
            await commandManager.validateCommand(deeplyNested),
            false,
            'FAIL: validation must fail closed when the parser hits its nesting limit'
        );

        // Test 16: interact_with_process must enforce blockedCommands before stdin write.
        await testInteractiveBlockedCommandValidation();

        if (process.platform === 'win32') {
            assert.strictEqual(await commandManager.validateCommand('po`wer`shell.exe -NoProfile'), false);
            const wrappers = 'cmd.exe /c '.repeat(25) + 'echo safe';
            assert.throws(() => commandManager.extractCommands(wrappers), /nesting depth/i);
            assert.strictEqual(await commandManager.validateCommand(wrappers), false);
            assert.match(commandManager.getUnsafeInlineInterpreterReason(wrappers), /nesting/i);
            assert.ok(commandManager.extractCommands('FOO="a b" cmd.exe /c rm').includes('rm'));
        }
        assert.match(commandManager.getUnsafeInlineInterpreterReason('FOO="a b" node -e "1"'), /inline interpreter/i);

        console.log('\nAll tests passed!');
    } catch (error) {
        console.error('Test failed:', error.message);
        process.exit(1);
    }
}

runTests().catch((error) => {
    console.error('Test execution failed:', error);
    process.exit(1);
});
