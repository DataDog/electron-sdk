import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { finished } from 'node:stream/promises';

import { getCommandInvocation } from './commandInvocation.ts';

export interface LoggedCommandOptions {
  command: string;
  args: string[];
  environment: Record<string, string>;
  logFile: string;
  retryDelays: number[];
}

export async function runLoggedCommand(options: LoggedCommandOptions): Promise<void> {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const log = fs.createWriteStream(options.logFile, { flags: 'a' });
  let logError: Error | undefined;
  // Observe open/write errors immediately, including while a command or retry delay is pending.
  const logFinished = finished(log).catch((error: Error) => {
    logError = error;
    console.error('Failed to write command log; continuing with console output:', error);
  });
  const attempts = options.retryDelays.length + 1;

  function throwIfLoggingFailed(): void {
    if (logError) throw logError;
  }

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfLoggingFailed();
      writeStatus(log, `Running attempt ${attempt}/${attempts}: ${formatCommand(options.command, options.args)}`);
      const result = await runAttempt(options.command, options.args, options.environment, log);
      // Let the command and its descendants finish, then surface logging failures to artifact cleanup.
      throwIfLoggingFailed();
      if (result.code === 0) break;

      const failure = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`;
      if (attempt === attempts) {
        throw new Error(`Command failed after ${attempts} attempt(s) with ${failure}.`);
      }

      const delay = options.retryDelays[attempt - 1];
      writeStatus(log, `Command failed with ${failure}. Retrying in ${delay}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally {
    log.end();
    await logFinished;
  }
  throwIfLoggingFailed();
}

async function runAttempt(
  command: string,
  args: string[],
  environment: Record<string, string>,
  log: fs.WriteStream
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const childEnvironment = { ...process.env, ...environment };
  const invocation = getCommandInvocation(command, args, { environment: childEnvironment });
  const child = childProcess.spawn(invocation.command, invocation.args, {
    env: childEnvironment,
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    if (!log.destroyed) log.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    if (!log.destroyed) log.write(chunk);
  });

  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
}

function writeStatus(log: fs.WriteStream, message: string): void {
  const line = `\n=== ${message} ===\n`;
  process.stdout.write(line);
  log.write(line);
}

function formatCommand(command: string, args: string[]): string {
  return [command, ...args].map((argument) => JSON.stringify(argument)).join(' ');
}
