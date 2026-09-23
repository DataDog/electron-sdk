import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getCommandInvocation } from './commandInvocation.ts';

let directory: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron yarn invocation '));
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

function writeEntryPoint(relativePath: string): string {
  const entryPoint = path.join(directory, relativePath);
  fs.mkdirSync(path.dirname(entryPoint), { recursive: true });
  fs.writeFileSync(entryPoint, 'console.log(JSON.stringify(process.argv.slice(2)));');
  return entryPoint;
}

describe('command invocation', () => {
  it.each(['darwin', 'linux'] as const)('preserves executable lookup on %s', (platform) => {
    const args = ['install', '--immutable'];
    expect(getCommandInvocation('yarn', args, { platform, environment: {} })).toEqual({ command: 'yarn', args });
  });

  it.each(['node', 'git', 'powershell.exe'])('does not append .cmd to the native Windows command %s', (command) => {
    expect(getCommandInvocation(command, ['--version'], { platform: 'win32', environment: {} })).toEqual({
      command,
      args: ['--version'],
    });
  });

  it('uses the active Yarn CLI while preserving argument boundaries', () => {
    const entryPoint = writeEntryPoint('yarn-4.17.1.cjs');
    const args = ['with spaces', 'a&b|c', 'quote"here', '', '%PATH%', '$(echo unexpected)'];
    const invocation = getCommandInvocation('yarn', args, {
      platform: 'win32',
      environment: { npm_execpath: entryPoint },
    });
    expect(invocation.command).toBe(process.execPath);
    const result = childProcess.spawnSync(invocation.command, invocation.args, { encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(args);
  });

  it.each(['node_modules/corepack/dist/yarn.js', 'node_modules/yarn/bin/yarn.js'])(
    'finds %s on the Windows Path before dependencies are installed',
    (relativePath) => {
      const entryPoint = writeEntryPoint(relativePath);
      expect(
        getCommandInvocation('yarn.cmd', ['install', '--immutable'], {
          platform: 'win32',
          environment: { Path: `${path.join(directory, 'missing')};${directory}` },
        })
      ).toEqual({ command: process.execPath, args: [entryPoint, 'install', '--immutable'] });
    }
  );

  it('finds the AMI Corepack installation alongside Node without mistaking npm for Yarn', () => {
    const entryPoint = writeEntryPoint('node_modules/corepack/dist/yarn.js');
    const npmEntryPoint = writeEntryPoint('npm-cli.js');
    const nodeExecutable = path.join(directory, 'node.exe');
    expect(
      getCommandInvocation('yarn', ['--version'], {
        platform: 'win32',
        nodeExecutable,
        environment: { npm_execpath: npmEntryPoint },
      })
    ).toEqual({ command: nodeExecutable, args: [entryPoint, '--version'] });
  });

  it('reports an actionable error when Yarn cannot be located', () => {
    expect(() =>
      getCommandInvocation('yarn', [], {
        platform: 'win32',
        nodeExecutable: path.join(directory, 'node.exe'),
        environment: {},
      })
    ).toThrow('Cannot locate the Yarn JavaScript entry point');
  });
});
