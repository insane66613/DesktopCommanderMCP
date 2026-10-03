#!/usr/bin/env node
// Simulates a background worker process that produces bursty output with pauses
process.stdout.write('Initialization complete.\n');
setTimeout(() => {
  process.stdout.write('Phase 1 intermediate processing complete.\n');
  setTimeout(() => {
    process.stdout.write('Phase 2 final processing finished.\n');
    setInterval(() => {}, 1000);
  }, 1200);
}, 1200);
