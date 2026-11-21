#!/usr/bin/env node
/**
 * Fail closed for normal build, clean and watch commands in an installed runtime.
 * The marker is local, untracked and belongs to the managed service operator.
 * A developer must use a separate checkout without the marker to build.
 */
import { lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const marker = path.join(root, '.desktopcommander-managed-runtime-protected');
try {
  // lstat recognizes even a dangling symlink: a marker cannot be bypassed
  // by changing its file type or temporarily breaking its target.
  lstatSync(marker);
  process.stderr.write(
    'REFUSED: This DeskCommand checkout contains an installed managed runtime.\n' +
    'Build, watch, clean, setup and release in a separate isolated checkout.\n' +
    'Do not overwrite production dist outside the supervised release.\n'
  );
  process.exit(78);
} catch (error) {
  if (error && error.code === 'ENOENT') process.exit(0);
  process.stderr.write(
    'REFUSED: Cannot safely check installed-runtime build marker: ' +
    String(error?.message ?? error) + '\n'
  );
  process.exit(78);
}
