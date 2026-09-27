import { _electron as electron, type ElectronApplication } from '@playwright/test';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';

type LaunchOptions = NonNullable<Parameters<typeof electron.launch>[0]>;
const executableHashes = new Map<string, Promise<string>>();
const windowsEnvironmentKeys = [
  'PATH',
  'SystemRoot',
  'WINDIR',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'COMSPEC',
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
  'PWDEBUG',
];

/** Logs Windows fixture startup milestones without swallowing operation errors. */
export async function logWindowsStartup<T>(stage: string, operation: () => Promise<T>): Promise<T> {
  if (process.platform !== 'win32') return operation();
  const started = Date.now();
  console.log(`[windows-startup] ${new Date().toISOString()} ${stage}: started`);
  try {
    const result = await operation();
    console.log(`[windows-startup] ${stage}: completed in ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    console.error(`[windows-startup] ${stage}: failed after ${Date.now() - started}ms`, error);
    throw error;
  }
}

/** Records launch inputs and lets Playwright's launch timeout report before the fixture timeout. */
export async function launchElectronWithWindowsDiagnostics(options: LaunchOptions): Promise<ElectronApplication> {
  if (process.platform !== 'win32') return electron.launch(options);
  console.log(
    '[windows-launch]',
    JSON.stringify({
      executablePath: options.executablePath,
      args: options.args,
      cwd: options.cwd ?? process.cwd(),
      node: process.version,
      expectedElectronVersion: process.env.DD_ELECTRON_EXPECTED_VERSION,
      hostEnvironment: selectEnvironment(process.env),
      childEnvironment: selectEnvironment(options.env ?? process.env),
      timeout: 20_000,
    })
  );
  try {
    if (options.executablePath) {
      const file = options.executablePath;
      const metadata = await stat(file);
      let hash = executableHashes.get(file);
      if (!hash) {
        hash = hashExecutable(file);
        executableHashes.set(file, hash);
      }
      console.log('[windows-executable]', JSON.stringify({ path: file, bytes: metadata.size, sha256: await hash }));
    }
  } catch (error) {
    console.error('[windows-executable] Could not inspect executable:', error);
  }
  const app = await logWindowsStartup('electron.launch', () => electron.launch({ ...options, timeout: 20_000 }));
  console.log(`[windows-startup] Electron process PID: ${app.process().pid}`);
  app.process().once('exit', (code, signal) => {
    console.log('[windows-process-exit]', JSON.stringify({ code, signal }));
  });
  return app;
}

function selectEnvironment(environment: Record<string, string | undefined>): Record<string, string | null> {
  return Object.fromEntries(
    windowsEnvironmentKeys.map((name) => {
      const key = Object.keys(environment).find((key) => key.toLowerCase() === name.toLowerCase());
      // Only paths are printed. Behavior flags report presence to avoid exposing arbitrary option values.
      const value = key === undefined ? null : (environment[key] ?? null);
      return [
        name,
        ['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE', 'PWDEBUG'].includes(name)
          ? value === null
            ? null
            : value === ''
              ? '(empty)'
              : '(set)'
          : value,
      ];
    })
  );
}

async function hashExecutable(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
