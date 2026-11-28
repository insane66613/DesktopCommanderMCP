import os from 'node:os';

/** Runtime diagnostics only; never return process.env or command arguments. */
export interface EnvironmentInfoOptions {
  includeNetwork?: boolean;
}

export function getEnvironmentInfo(options: EnvironmentInfoOptions = {}) {
  const memory = process.memoryUsage();
  const interfaces = options.includeNetwork
    ? Object.entries(os.networkInterfaces()).slice(0, 32).flatMap(([name, addresses]) =>
        (addresses ?? []).slice(0, 8).map(address => ({
          name, family: address.family, address: address.address,
          internal: address.internal,
        })))
    : undefined;

  return {
    capturedAt: new Date().toISOString(),
    process: {
      pid: process.pid,
      uptimeSeconds: Math.floor(process.uptime()),
      cwd: process.cwd(),
      nodeVersion: process.version,
      memoryBytes: {
        rss: memory.rss, heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal, external: memory.external,
      },
    },
    system: {
      platform: os.platform(),
      architecture: os.arch(),
      release: os.release(),
      hostname: os.hostname(),
      cpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      freeMemoryBytes: os.freemem(),
      uptimeSeconds: Math.floor(os.uptime()),
    },
    ...(interfaces ? { networkInterfaces: interfaces } : {}),
  };
}
