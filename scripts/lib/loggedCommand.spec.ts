import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import { Writable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { runLoggedCommand } from './loggedCommand.ts';

it('retains both output streams across retries and propagates exhausted failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-command-'));
  const marker = path.join(root, 'attempt');
  const logFile = path.join(root, 'command.log');
  try {
    await runLoggedCommand({
      command: process.execPath,
      args: [
        '-e',
        `
        const fs = require('node:fs');
        console.log('stdout marker');
        console.error('stderr marker');
        if (!fs.existsSync(process.env.ATTEMPT_MARKER)) {
          fs.writeFileSync(process.env.ATTEMPT_MARKER, 'retried');
          process.exit(7);
        }
      `,
      ],
      environment: { ATTEMPT_MARKER: marker },
      logFile,
      retryDelays: [0],
    });
    const log = await fs.readFile(logFile, 'utf8');
    expect(log).toContain('stdout marker');
    expect(log).toContain('stderr marker');
    expect(log).toContain('Running attempt 2/2');
    await expect(
      runLoggedCommand({
        command: process.execPath,
        args: ['-e', 'process.exit(7)'],
        environment: {},
        logFile,
        retryDelays: [],
      })
    ).rejects.toThrow('exit code 7');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('rejects log opening failures', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-command-'));
  try {
    await expect(
      runLoggedCommand({
        command: process.execPath,
        args: ['-e', 'console.log("command completed")'],
        environment: {},
        logFile: root, // Opening a directory as a log file fails on every platform.
        retryDelays: [],
      })
    ).rejects.toThrow();
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

it('lets the command finish before rejecting a mid-command log write failure', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'windows-command-'));
  const failure = new Error('simulated disk full');
  const marker = path.join(root, 'completed');
  const log = new Writable({
    write(chunk, _encoding, callback) {
      callback(chunk.toString().trim() === 'child started' ? failure : undefined);
    },
  });
  const createLog = vi.spyOn(syncFs, 'createWriteStream').mockReturnValue(log as syncFs.WriteStream);
  try {
    await expect(
      runLoggedCommand({
        command: process.execPath,
        args: [
          '-e',
          "console.log('child started'); setTimeout(() => require('node:fs').writeFileSync(process.env.COMPLETION_MARKER, 'complete'), 25)",
        ],
        environment: { COMPLETION_MARKER: marker },
        logFile: path.join(root, 'command.log'),
        retryDelays: [0],
      })
    ).rejects.toBe(failure);
    expect(await fs.readFile(marker, 'utf8')).toBe('complete');
  } finally {
    createLog.mockRestore();
    await fs.rm(root, { recursive: true, force: true });
  }
});
