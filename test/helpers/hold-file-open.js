import { spawn } from 'child_process';
import { psQuote } from './powershell.js';

// Hold a real file handle so Windows rename retry tests exercise sharing locks.
export function holdFileOpen(filePath, ms, share = 'Read') {
  const child = process.platform === 'win32'
    ? spawn('pwsh.exe', ['-NoProfile', '-Command',
        `$ErrorActionPreference = 'Stop'; $f = [IO.File]::Open(${psQuote(filePath)}, 'Open', 'Read', ${psQuote(share)}); Write-Output locked; Start-Sleep -Milliseconds ${ms}; $f.Close()`])
    : spawn(process.execPath, ['-e',
        `const fs = require('fs'); const fd = fs.openSync(${JSON.stringify(filePath)}, 'r'); console.log('locked'); setTimeout(() => fs.closeSync(fd), ${ms});`]);
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code, signal) => reject(new Error(`file holder exited before opening ${filePath} (${signal ?? code})`)));
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('locked')) resolve(child);
    });
  });
}
