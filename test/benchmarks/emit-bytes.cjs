#!/usr/bin/env node
const bytes = parseInt(process.argv[2] || '20480', 10);
const chunkSize = 1024;
let written = 0;
while (written < bytes) {
  const current = Math.min(chunkSize, bytes - written);
  if (current === chunkSize) {
    process.stdout.write('X'.repeat(current - 1) + '\n');
  } else {
    process.stdout.write('Y'.repeat(current));
  }
  written += current;
}
