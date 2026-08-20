import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface LoggedCommandOptions {
  command: string;
  args: string[];
  environment: Record<string, string>;
  logFile: string;
  retryDelays: number[];
}

export function parseLoggedCommandOptions(args: string[]): LoggedCommandOptions {
  const separatorIndex = args.indexOf('--');
  if (separatorIndex === -1 || separatorIndex === args.length - 1) {
    throw new Error('Expected a command after "--".');
  }

  const optionArgs = args.slice(0, separatorIndex);
  const commandArgs = args.slice(separatorIndex + 1);
  let logFile: string | undefined;
  const environment: Record<string, string> = {};
  const retryDelays: number[] = [];

  for (let index = 0; index < optionArgs.length; index += 1) {
    const option = optionArgs[index];
    const value = optionArgs[index + 1];
    if (option === '--log') {
      if (!value) throw new Error('--log requires a file path.');
      logFile = value;
      index += 1;
      continue;
    }
    if (option === '--env') {
      const assignmentIndex = value?.indexOf('=') ?? -1;
      const name = value?.slice(0, assignmentIndex);
      if (!value || assignmentIndex < 1 || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new Error('--env requires a NAME=value assignment.');
      }
      environment[name] = value.slice(assignmentIndex + 1);
      index += 1;
      continue;
    }
    if (option === '--retry-delay') {
      const delay = Number(value);
      if (!value || !Number.isSafeInteger(delay) || delay < 0) {
        throw new Error('--retry-delay requires a non-negative integer in milliseconds.');
      }
      retryDelays.push(delay);
      index += 1;
      continue;
    }
    throw new Error(`Unknown logged-command option "${option}".`);
  }

  if (!logFile) throw new Error('--log is required.');
  return {
    command: commandArgs[0],
    args: commandArgs.slice(1),
    environment,
    logFile,
    retryDelays,
  };
}

export async function runLoggedCommand(options: LoggedCommandOptions): Promise<void> {
  fs.mkdirSync(path.dirname(options.logFile), { recursive: true });
  const log = fs.createWriteStream(options.logFile, { flags: 'a' });
  const attempts = options.retryDelays.length + 1;

  try {
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      writeStatus(log, `Running attempt ${attempt}/${attempts}: ${formatCommand(options.command, options.args)}`);
      const result = await runAttempt(options.command, options.args, options.environment, log);
      if (result.code === 0) return;

      const failure = result.signal ? `signal ${result.signal}` : `exit code ${result.code ?? 'unknown'}`;
      if (attempt === attempts) {
        throw new Error(`Command failed after ${attempts} attempt(s) with ${failure}.`);
      }

      const delay = options.retryDelays[attempt - 1];
      writeStatus(log, `Command failed with ${failure}. Retrying in ${delay}ms.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  } finally {
    await new Promise<void>((resolve, reject) => {
      log.end(resolve);
      log.on('error', reject);
    });
  }
}

async function runAttempt(
  command: string,
  args: string[],
  environment: Record<string, string>,
  log: fs.WriteStream
): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  const executable = process.platform === 'win32' && !/\.(?:bat|cmd|exe)$/i.test(command) ? `${command}.cmd` : command;
  const child = childProcess.spawn(executable, args, {
    env: { ...process.env, ...environment },
    stdio: ['inherit', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
    log.write(chunk);
  });
  child.stderr.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    log.write(chunk);
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
