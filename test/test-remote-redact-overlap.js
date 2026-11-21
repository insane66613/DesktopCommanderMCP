#!/usr/bin/env node
/** Regression for upstream 65ea2fbc and its username-overlap review finding. */
import assert from 'node:assert/strict';
import os from 'node:os';
import { redact } from '../dist/remote-device/diagnostics/redact.js';

const originalHostname = os.hostname;
const originalUserInfo = os.userInfo;
const uuid = '12345678-abcd-1234-5678-abcdef123456';
const setIds = (host, user) => {
    os.hostname = () => host;
    os.userInfo = () => ({ username: user });
};
try {
    // Baseline leaked "desk-<id>-station.office.local" when the UUID was
    // redacted before the longer overlapping machine name.
    const fullHost = `desk-${uuid}-station.office.local`;
    setIds(fullHost, 'isolated-user');
    assert.equal(redact(`connected ${fullHost} at noon`), 'connected <private> at noon');
    assert.equal(redact(`uuid=${uuid} host=${fullHost}`), 'uuid=<id> host=<private>');
    assert.equal(redact(`HOST=${fullHost.toUpperCase()}`), 'HOST=<private>',
        'case-insensitive full hostname must not leak uppercase identifiers');

    setIds('12345678-abcd', 'isolated-user');
    assert.equal(redact(uuid), '<private>',
        'UUID overlapping the hostname prefix must be fully masked');

    // Copilot review reproduced a separate leak: user=lab-admin, hostname=lab
    // became "<host>-admin" because the username matcher ran afterward.
    setIds('lab', 'lab-admin');
    assert.equal(redact('operator lab-admin connected'), 'operator <private> connected',
        'a username containing the hostname must not expose the username suffix');
    setIds('lab-admin', 'lab');
    assert.equal(redact('operator lab-admin connected'), 'operator <private> connected',
        'a hostname containing the username must not expose hostname fragments');

    setIds('lab.office.local', 'alice');
    assert.equal(redact('host lab.office.local; short lab; user alice; id ' + uuid),
        'host <host>; short <host>; user <user>; id <id>',
        'independent values must retain their specific markers');

    setIds(`desk-${uuid}-alice`, 'alice');
    assert.equal(redact(`desk-${uuid}-alice`), '<private>',
        'triple-category overlap must hide the complete value');

    const long = ('regular diagnostic line\n'.repeat(5000)) + `node lab.office.local user alice id ${uuid}`;
    setIds('lab.office.local', 'alice');
    const masked = redact(long);
    assert.equal(masked.length > 90000, true);
    assert.equal(masked.endsWith('node <host> user <user> id <id>'), true);
    assert.equal(masked.includes(uuid), false);
    console.log('PASS overlapping hostname, UUID and username privacy, mixed markers and large diagnostics');
} finally {
    os.hostname = originalHostname;
    os.userInfo = originalUserInfo;
}
