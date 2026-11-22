#!/usr/bin/env node
// Short-lived child to exercise the real startup logger without remote access.
import { MCPDevice } from '../../dist/remote-device/device.js';

process.env.DESKTOP_COMMANDER_DISABLE_TELEMETRY = '1';
const fakeDevice = {
    baseServerUrl: 'https://private-endpoint.desktopcommander.app',
    desktop: {
        initialize: async () => {},
        onDisconnect: () => {},
    },
    fetchSupabaseConfig: async () => {
        throw new Error('intentional startup stop');
    },
    shutdown: async () => {},
};
await MCPDevice.prototype.start.call(fakeDevice);
