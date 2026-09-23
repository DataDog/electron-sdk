import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { command } from './command.ts';
import { runLoggedCommand } from './loggedCommand.ts';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron command tests '));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

const argumentsWithSpecialCharacters = [
  'with spaces',
  'a&b|c',
  '(value)',
  'quote"here',
  'backslash\\',
  '',
  'snowman-☃',
];

describe('command execution', () => {
  it('preserves arguments, working directory, environment, and stdin', () => {
    const script = `
      const fs = require('node:fs');
      console.log(JSON.stringify({
        args: process.argv.slice(1),
        cwd: fs.realpathSync(process.cwd()),
        value: process.env.COMMAND_TEST_VALUE,
        input: fs.readFileSync(0, 'utf8'),
      }));
    `;
    const output = command`${process.execPath} -e ${script} ${argumentsWithSpecialCharacters}`
      .withCurrentWorkingDirectory(directory)
      .withEnvironment({ COMMAND_TEST_VALUE: 'literal & value' })
      .withInput('input with spaces')
      .run();

    expect(JSON.parse(output)).toEqual({
      args: argumentsWithSpecialCharacters,
      cwd: fs.realpathSync(directory),
      value: 'literal & value',
      input: 'input with spaces',
    });
  });

  it('reports a failing command and its output', () => {
    const script = "console.error('intentional failure'); process.exit(7)";
    expect(() => command`${process.execPath} -e ${script}`.run()).toThrow(/exit status 7[\s\S]*intentional failure/);
  });

  it('reports a missing executable', () => {
    expect(() => command`${path.join(directory, 'missing-executable')}`.run()).toThrow('Command failed');
  });
});

describe('logged command execution', () => {
  it('boots the logging CLI from a checkout without node_modules', () => {
    fs.mkdirSync(path.join(directory, 'lib'));
    for (const file of ['commandInvocation.ts', 'executionUtils.ts', 'loggedCommand.ts']) {
      fs.copyFileSync(new URL(file, import.meta.url), path.join(directory, 'lib', file));
    }
    const entryPoint = path.join(directory, 'run-command-with-logs.ts');
    fs.copyFileSync(new URL('../run-command-with-logs.ts', import.meta.url), entryPoint);
    const logFile = path.join(directory, 'bootstrap.log');
    const result = childProcess.spawnSync(
      process.execPath,
      [entryPoint, '--log', logFile, '--', process.execPath, '-e', "console.log('bootstrap succeeded')"],
      { cwd: directory, encoding: 'utf8' }
    );

    expect(result.status, result.stderr).toBe(0);
    expect(fs.readFileSync(logFile, 'utf8')).toContain('bootstrap succeeded');
  });

  it('resolves a native executable and captures both output streams', async () => {
    const logFile = path.join(directory, 'logs', 'command.log');
    const script = `
      console.log(JSON.stringify({args: process.argv.slice(1), value: process.env.COMMAND_TEST_VALUE}));
      console.error('stderr marker');
    `;
    await runLoggedCommand({
      command: 'node',
      args: ['-e', script, ...argumentsWithSpecialCharacters],
      environment: { COMMAND_TEST_VALUE: 'literal & value' },
      logFile,
      retryDelays: [],
    });

    const log = fs.readFileSync(logFile, 'utf8');
    expect(log).toContain(JSON.stringify({ args: argumentsWithSpecialCharacters, value: 'literal & value' }));
    expect(log).toContain('stderr marker');
  });

  it('retries nonzero exits and reports the final failure', async () => {
    const logFile = path.join(directory, 'failure.log');
    await expect(
      runLoggedCommand({
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        environment: {},
        logFile,
        retryDelays: [0],
      })
    ).rejects.toThrow('Command failed after 2 attempt(s) with exit code 7');
    expect(fs.readFileSync(logFile, 'utf8')).toContain('Running attempt 2/2');
  });

  it('reports spawn errors and closes the log', async () => {
    await expect(
      runLoggedCommand({
        command: path.join(directory, 'missing-executable'),
        args: [],
        environment: {},
        logFile: path.join(directory, 'missing.log'),
        retryDelays: [],
      })
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('Windows Yarn execution', () => {
  it.skipIf(process.platform !== 'win32').each(['sync', 'logged'] as const)(
    'runs the installed Yarn CLI using the %s helper',
    async (runner) => {
      if (runner === 'sync') {
        expect(command`yarn --version`.run().trim()).toBe('4.17.1');
      } else {
        const logFile = path.join(directory, 'yarn.log');
        await runLoggedCommand({ command: 'yarn', args: ['--version'], environment: {}, logFile, retryDelays: [] });
        expect(fs.readFileSync(logFile, 'utf8')).toContain('4.17.1');
      }
    }
  );
});
