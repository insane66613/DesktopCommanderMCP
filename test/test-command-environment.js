#!/usr/bin/env node
/** Regression for upstream Windows ProgramData and PATHEXT repair (#702 / #481). */
import assert from 'node:assert/strict';
import { getCommandEnvironment } from '../dist/utils/command-environment.js';

const original = { SystemDrive: 'C:', PATHEXT: '.CPL', PATH: 'example' };
const fixed = getCommandEnvironment(original, 'win32');
assert.equal(fixed.ProgramData, 'C:\\ProgramData');
assert.ok(fixed.PATHEXT.includes('.EXE'));
assert.ok(fixed.PATHEXT.includes('.CPL'));
assert.equal(fixed.PATH, 'example');
assert.equal(original.ProgramData, undefined, 'caller environment is never mutated');
assert.equal(original.PATHEXT, '.CPL');

const rootOnly = getCommandEnvironment({ SystemRoot: 'D:\\Windows' }, 'win32');
assert.equal(rootOnly.ProgramData, 'D:\\ProgramData');
const noDrive = getCommandEnvironment({ PATHEXT: '.EXE' }, 'win32');
assert.equal(noDrive.ProgramData, undefined, 'do not guess an absent system drive');

const existing = getCommandEnvironment({ programdata: 'E:\\MyData', PathExt: '.EXE;.CUSTOM' }, 'win32');
assert.equal(existing.programdata, 'E:\\MyData', 'existing ProgramData must be preserved');
assert.equal(existing.ProgramData, undefined, 'do not insert duplicate case-insensitive names');
assert.equal(existing.PATHEXT, '.EXE;.CUSTOM');
assert.equal(existing.PathExt, undefined, 'remove duplicate PATHEXT spelling');

const nonWindows = getCommandEnvironment({ PATHEXT: '.CPL', SystemDrive: 'C:' }, 'linux');
assert.deepEqual(nonWindows, { PATHEXT: '.CPL', SystemDrive: 'C:' });

const lowercaseDrive = getCommandEnvironment({ systemdrive: 'Q:', pathext: '.BAT' }, 'win32');
assert.equal(lowercaseDrive.ProgramData, 'Q:\\ProgramData');
assert.ok(lowercaseDrive.PATHEXT.includes('.EXE'));
console.log('PASS command environment keeps Windows OpenSSH and executable resolution functional');
