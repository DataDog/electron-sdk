import { describe, expect, it } from 'vitest';

import { parseLoggedCommandOptions } from './loggedCommand.ts';

describe('logged command options', () => {
  it('parses a log path, retry delays, and the command independently', () => {
    expect(
      parseLoggedCommandOptions([
        '--log',
        'logs/install.log',
        '--retry-delay',
        '2000',
        '--retry-delay',
        '5000',
        '--env',
        'ELECTRON_SKIP_BINARY_DOWNLOAD=1',
        '--',
        'yarn',
        'install',
        '--immutable',
      ])
    ).toEqual({
      command: 'yarn',
      args: ['install', '--immutable'],
      environment: { ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
      logFile: 'logs/install.log',
      retryDelays: [2000, 5000],
    });
  });

  it('rejects missing commands, log paths, and invalid retry delays', () => {
    expect(() => parseLoggedCommandOptions(['--log', 'logs/install.log'])).toThrow('Expected a command');
    expect(() => parseLoggedCommandOptions(['--', 'yarn'])).toThrow('--log is required');
    expect(() => parseLoggedCommandOptions(['--log', 'install.log', '--env', 'INVALID', '--', 'yarn'])).toThrow(
      'NAME=value'
    );
    expect(() => parseLoggedCommandOptions(['--log', 'logs/install.log', '--retry-delay', '-1', '--', 'yarn'])).toThrow(
      'non-negative integer'
    );
  });
});
