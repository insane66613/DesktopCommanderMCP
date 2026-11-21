/** Construct a safe command environment without changing the MCP process. */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

function readEnvironmentValue(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const name = Object.keys(env).find(candidate => candidate.toUpperCase() === key);
  return name === undefined ? undefined : env[name];
}

function removeEnvironmentKey(env: NodeJS.ProcessEnv, key: string): void {
  for (const name of Object.keys(env)) {
    if (name.toUpperCase() === key) delete env[name];
  }
}

/** Backport of upstream #702: fix omitted ProgramData and broken PATHEXT. */
export function getCommandEnvironment(
  source: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...source };
  if (platform !== 'win32') return env;
  // Windows environment keys are case-insensitive. Avoid duplicate variants:
  // Node chooses only the first matching key when spawning a child.
  const ext = readEnvironmentValue(source, 'PATHEXT');
  const extensions = (ext ?? '').split(';').map(value => value.trim().toUpperCase()).filter(Boolean);
  const repaired = extensions.includes('.EXE')
    ? ext!
    : [...new Set([...STANDARD_PATHEXT.split(';'), ...extensions])].join(';');
  removeEnvironmentKey(env, 'PATHEXT');
  env.PATHEXT = repaired;

  if (!readEnvironmentValue(source, 'PROGRAMDATA')?.trim()) {
    const configuredDrive = readEnvironmentValue(source, 'SYSTEMDRIVE') ?? '';
    const root = readEnvironmentValue(source, 'SYSTEMROOT') ?? '';
    const drive = /^[A-Za-z]:$/.test(configuredDrive)
      ? configuredDrive
      : /^[A-Za-z]:[\\/]/.test(root) ? root.slice(0, 2) : '';
    if (drive) {
      removeEnvironmentKey(env, 'PROGRAMDATA');
      env.ProgramData = `${drive}\\ProgramData`;
    }
  }
  return env;
}
