import { mockFs } from '../../../mocks.specUtil';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/crash/dumps'),
    getName: vi.fn(() => 'TestApp'),
  },
  crashReporter: {
    start: vi.fn(),
  },
}));

vi.mock('../../../tools/display', () => ({
  displayError: vi.fn(),
  displayInfo: vi.fn(),
}));

vi.mock('../../../wasm', () => ({
  processMinidump: vi.fn(),
}));

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { crashReporter } from 'electron';
import { type TimeStamp } from '@datadog/browser-core';
import { CrashCollection } from './CrashCollection';
import { EventManager, EventKind, EventFormat, type RawRumEvent } from '../../../event';
import { processMinidump } from '../../../wasm';
import type { CrashReport } from '../../../wasm';
import type { RawRumError } from '../rawRumData.types';
import { displayError } from '../../../tools/display';

vi.mock('node:fs/promises');
const mfs = mockFs();

function createMinidumpResult(overrides?: Partial<CrashReport>): CrashReport {
  return {
    status: 'OK',
    crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 0 },
    system_info: { os: 'mac', cpu: 'amd64', cpu_info: '' },
    crashing_thread: {
      thread_index: 0,
      frame_count: 1,
      frames: [
        { module: '/usr/lib/app', function: 'main', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
      ],
    },
    thread_count: 1,
    threads: [
      {
        thread_index: 0,
        frame_count: 1,
        frames: [
          { module: '/usr/lib/app', function: 'main', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
        ],
      },
    ],
    module_count: 1,
    modules: [
      {
        base_address: '0x1000',
        size: 4096,
        code_file: '/usr/lib/libSystem.B.dylib',
        code_identifier: null,
        debug_file: null,
        debug_identifier: 'AABB',
        version: null,
      },
    ],
    ...overrides,
  };
}

function mockDmpFile(name = 'crash.dmp', birthtimeMs = 0) {
  mfs.readdir.mockResolvedValue([{ name, isFile: () => true, isDirectory: () => false }]);
  mfs.stat.mockResolvedValue({ birthtimeMs });
  mfs.readFile.mockResolvedValue(new Uint8Array([1]));
  mfs.unlink.mockResolvedValue(undefined);
}

async function startAndFlush(eventManager: EventManager) {
  CrashCollection.start(eventManager);
  await vi.advanceTimersToNextTimerAsync();
}

describe('CrashCollection', () => {
  let eventManager: EventManager;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    eventManager = new EventManager();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });

    mfs.readdir.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    mfs.reset();
  });

  it('starts the native crash reporter', () => {
    CrashCollection.start(eventManager);

    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(crashReporter.start).toHaveBeenCalledWith({ uploadToServer: false, ignoreSystemCrashHandler: true });
  });

  it('does nothing when no crash dumps exist', async () => {
    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(0);
  });

  it('does nothing when crash dumps directory does not exist', async () => {
    mfs.readdir.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(0);
  });

  it('processes a .dmp file and emits a crash error event', async () => {
    const crashTime = 1000 as TimeStamp;
    mockDmpFile('crash.dmp', crashTime);
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    const event = rawRumEvents[0];
    expect(event.startTime).toBe(crashTime);

    const data = event.data as RawRumError;
    expect(data.date).toBe(crashTime);
    expect(data.type).toBe('error');
    expect(data.error.is_crash).toBe(true);
    expect(data.error.category).toBe('Exception');
    expect(data.error.handling).toBe('unhandled');
    expect(data.error.source).toBe('source');
    expect(data.error.type).toBe('SIGSEGV');
    expect(data.error.message).toBe('Application crashed');
  });

  it('sets source_type from system_info.os', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({ system_info: { os: 'mac', cpu: 'arm64', cpu_info: '' } })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.source_type).toBe('mac');
  });

  it('formats thread stack with addresses and decimal offset', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 2,
            frames: [
              {
                module: '/path/to/app',
                function: 'crashFunc',
                instruction: '0x1010',
                module_offset: '0x10',
                trust: 'context',
              },
              { module: '/path/to/app', function: 'main', instruction: '0x1020', module_offset: '0x20', trust: 'cfi' },
            ],
          },
        ],
        modules: [
          {
            base_address: '0x1000',
            size: 4096,
            code_file: '/path/to/app',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.stack).toBe(
      '0  app 0x0000000000001010 0x0000000000001000 + 16\n' + '0  app 0x0000000000001020 0x0000000000001000 + 32'
    );
  });

  it('uses error.stack from crashed thread', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 1 },
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '/path/to/lib', function: 'wait', instruction: '0x2000', module_offset: '0x100', trust: 'cfi' },
            ],
          },
          {
            thread_index: 1,
            frame_count: 1,
            frames: [
              {
                module: '/path/to/app',
                function: 'crash',
                instruction: '0x1000',
                module_offset: '0x50',
                trust: 'context',
              },
            ],
          },
        ],
        modules: [
          {
            base_address: '0x1000',
            size: 100,
            code_file: '/path/to/app',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
          {
            base_address: '0x2000',
            size: 100,
            code_file: '/path/to/lib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'BB',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.stack).toBe('1  app 0x0000000000001000 0x0000000000001000 + 80');
  });

  it('includes threads with crashed flag', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        crash_info: { type: 'SIGSEGV', address: '0x0', crashing_thread: 0 },
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '/path/to/app', function: 'crash', instruction: '0x1', module_offset: '0x1', trust: 'context' },
            ],
          },
          {
            thread_index: 1,
            frame_count: 1,
            frames: [
              { module: '/path/to/lib', function: 'wait', instruction: '0x2', module_offset: '0x2', trust: 'cfi' },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.threads).toHaveLength(2);
    expect(data.error.threads![0].crashed).toBe(true);
    expect(data.error.threads![0].name).toBe('Thread 0');
    expect(data.error.threads![1].crashed).toBe(false);
    expect(data.error.threads![1].name).toBe('Thread 1');
  });

  it('formats binary images with 64-bit addresses and arch', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        system_info: { os: 'mac', cpu: 'arm64', cpu_info: '' },
        modules: [
          {
            base_address: '0x7fff5fc01000',
            size: 4096,
            code_file: '/usr/lib/libSystem.B.dylib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.binary_images).toHaveLength(1);
    const image = data.error.binary_images![0];
    expect(image.load_address).toBe('0x00007fff5fc01000');
    expect(image.max_address).toBe('0x00007fff5fc02000');
    expect(image.arch).toBe('arm64');
    expect(image.name).toBe('libSystem.B.dylib');
    expect(image.is_system).toBe(true);
  });

  it('classifies binary images with is_system', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        modules: [
          {
            base_address: '0x1000',
            size: 100,
            code_file: '/usr/lib/libSystem.B.dylib',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'AA',
            version: null,
          },
          {
            base_address: '0x2000',
            size: 200,
            code_file: '/Applications/MyApp.app/Contents/MacOS/MyApp',
            code_identifier: null,
            debug_file: null,
            debug_identifier: 'BB',
            version: null,
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.binary_images).toHaveLength(2);
    expect(data.error.binary_images![0].is_system).toBe(true);
    expect(data.error.binary_images![0].name).toBe('libSystem.B.dylib');
    expect(data.error.binary_images![1].is_system).toBe(false);
    expect(data.error.binary_images![1].name).toBe('MyApp');
  });

  it('deletes processed .dmp file', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    expect(mfs.unlink).toHaveBeenCalledWith('/mock/crash/dumps/crash.dmp');
  });

  it('skips non-.dmp files', async () => {
    mfs.readdir.mockResolvedValue([
      { name: 'crash.dmp', isFile: () => true, isDirectory: () => false },
      { name: 'notes.txt', isFile: () => true, isDirectory: () => false },
    ]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0 });
    mfs.readFile.mockResolvedValue(new Uint8Array([1]));
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
    mfs.unlink.mockResolvedValue(undefined);

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
  });

  it('continues processing remaining files when one fails', async () => {
    mfs.readdir.mockResolvedValue([
      { name: 'bad.dmp', isFile: () => true, isDirectory: () => false },
      { name: 'good.dmp', isFile: () => true, isDirectory: () => false },
    ]);
    mfs.stat.mockResolvedValue({ birthtimeMs: 0 });
    mfs.readFile.mockRejectedValueOnce(new Error('read error')).mockResolvedValueOnce(new Uint8Array([1]));
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());
    mfs.unlink.mockResolvedValue(undefined);

    await startAndFlush(eventManager);

    expect(rawRumEvents).toHaveLength(1);
    expect(displayError).toHaveBeenCalledWith(
      'Failed to process crash dump:',
      '/mock/crash/dumps/bad.dmp',
      expect.any(Error)
    );
  });

  it('uses ??? for unknown module names', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(
      createMinidumpResult({
        threads: [
          {
            thread_index: 0,
            frame_count: 1,
            frames: [
              { module: '', function: 'unknown', instruction: '0x1000', module_offset: '0x100', trust: 'context' },
            ],
          },
        ],
      })
    );

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.threads![0].stack).toContain('???');
  });

  it('includes meta with process info', async () => {
    mockDmpFile();
    vi.mocked(processMinidump).mockResolvedValue(createMinidumpResult());

    await startAndFlush(eventManager);

    const data = rawRumEvents[0].data as RawRumError;
    expect(data.error.meta).toEqual({
      code_type: 'amd64',
      process: 'TestApp',
      exception_type: 'SIGSEGV',
    });
  });
});
