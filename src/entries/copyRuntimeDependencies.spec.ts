import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import * as fs from 'node:fs/promises';
import type { Stats } from 'node:fs';

vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  chmod: vi.fn(),
  cp: vi.fn(),
  mkdir: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  readdir: vi.fn(),
  realpath: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
}));
vi.mock('node:module', () => ({ createRequire: vi.fn() }));

import { copyRuntimeDependencies } from './copyRuntimeDependencies';

const source = resolve('packages');
const output = resolve('output');
const staging = join(output, 'node_modules/.datadog-runtime-test');
const tracerBackup = join(output, 'node_modules/.datadog-runtime-test-dd-trace-electron-previous');
const tracer = join(source, 'tracer');
const sdk = join(source, 'sdk');
const plugin = join(sdk, 'dist/plugin.cjs');
const manifests = new Map<
  string,
  { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }
>();
const resolutions = new Map<string, Record<string, string>>();

describe('copyRuntimeDependencies', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    manifests.clear();
    resolutions.clear();
    vi.mocked(fs.readdir).mockResolvedValue([]);
    vi.mocked(fs.stat).mockResolvedValue({ mode: 0o755 } as Stats);
    vi.mocked(fs.mkdtemp).mockResolvedValue(staging);
    vi.mocked(fs.realpath).mockImplementation((file) => Promise.resolve(resolve(String(file))));
    manifests.set(tracer, {});
    manifests.set(sdk, { dependencies: { 'dd-trace-electron': '1' } });
    resolutions.set(plugin, { 'dd-trace-electron': tracer, '@datadog/electron-sdk': sdk });
    resolutions.set(join(sdk, 'package.json'), { 'dd-trace-electron': tracer });
    vi.mocked(createRequire).mockImplementation((file) => {
      const resolver = vi.fn() as unknown as NodeRequire;
      resolver.resolve = vi.fn((request: string) => {
        const name = request.replace(/\/package.json$/, '');
        const directory = resolutions.get(String(file))?.[name];
        if (!directory) throw new Error(`Cannot find '${request}' from '${String(file)}'`);
        return join(directory, request.endsWith('/package.json') ? 'package.json' : 'index.js');
      }) as unknown as NodeRequire['resolve'];
      return resolver;
    });
    vi.mocked(fs.readFile).mockImplementation((file) => {
      const manifest = manifests.get(dirname(file as string));
      if (!manifest) return Promise.reject(new Error(`Missing manifest: ${file as string}`));
      return Promise.resolve(JSON.stringify(manifest));
    });
  });

  it.each(['same directory', 'symlinked directory'])('preserves the installed packages in the %s', async (layout) => {
    const installedTracer = layout === 'same directory' ? join(output, 'node_modules/dd-trace-electron') : tracer;
    const installedSdk = layout === 'same directory' ? join(output, 'node_modules/@datadog/electron-sdk') : sdk;
    manifests.set(installedTracer, {});
    manifests.set(installedSdk, {});
    resolutions.set(plugin, { 'dd-trace-electron': installedTracer, '@datadog/electron-sdk': installedSdk });
    vi.mocked(fs.realpath).mockImplementation((file) => {
      if (file === join(output, 'node_modules/dd-trace-electron')) return Promise.resolve(installedTracer);
      if (file === join(output, 'node_modules/@datadog/electron-sdk')) return Promise.resolve(installedSdk);
      return Promise.resolve(resolve(String(file)));
    });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.cp).not.toHaveBeenCalled();
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it('leaves an isolated installation untouched when only the SDK is a root dependency', async () => {
    vi.mocked(fs.realpath).mockImplementation((file) => {
      if (file === join(output, 'node_modules/dd-trace-electron')) {
        return Promise.reject(Object.assign(new Error('Transitive dependency is not hoisted'), { code: 'ENOENT' }));
      }
      if (file === join(output, 'node_modules/@datadog/electron-sdk')) return Promise.resolve(sdk);
      return Promise.resolve(resolve(String(file)));
    });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.mkdtemp).not.toHaveBeenCalled();
    expect(fs.cp).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });

  it('resolves each dependency from its parent and stages a self-contained nested tree', async () => {
    const child = join(source, 'child');
    manifests.set(tracer, { dependencies: { child: '1' } });
    manifests.set(child, {});
    resolutions.set(join(tracer, 'package.json'), { child });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.cp).toHaveBeenCalledWith(child, join(staging, 'dd-trace-electron/node_modules/child'), expect.anything());
    const options = vi.mocked(fs.cp).mock.calls[0][2]!;
    expect(options.recursive).toBe(true);
    expect(options.dereference).toBe(true);
    expect(options.filter!(join(tracer, 'node_modules'), '')).toBe(false);
    expect(options.filter!(join(tracer, 'vendor/node_modules'), '')).toBe(true);
    expect(fs.cp).toHaveBeenCalledTimes(3);
  });

  it('preserves distinct versions of a dependency required by different parents', async () => {
    const sharedV1 = join(source, 'shared-v1');
    const sharedV2 = join(source, 'shared-v2');
    manifests.set(tracer, { dependencies: { shared: '1' } });
    manifests.set(sdk, { dependencies: { shared: '2' } });
    manifests.set(sharedV1, {});
    manifests.set(sharedV2, {});
    resolutions.set(join(tracer, 'package.json'), { shared: sharedV1 });
    resolutions.set(join(sdk, 'package.json'), { shared: sharedV2 });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.cp).toHaveBeenCalledWith(
      sharedV1,
      join(staging, 'dd-trace-electron/node_modules/shared'),
      expect.anything()
    );
    expect(fs.cp).toHaveBeenCalledWith(
      sharedV2,
      join(staging, '@datadog/electron-sdk/node_modules/shared'),
      expect.anything()
    );
  });

  it('makes copied read-only directories writable without changing source permissions', async () => {
    const destination = join(staging, 'dd-trace-electron');
    const entries = [
      { parentPath: destination, name: 'vendor', isDirectory: () => true },
      { parentPath: destination, name: 'index.js', isDirectory: () => false },
    ] as unknown as Awaited<ReturnType<typeof fs.readdir>>;
    vi.mocked(fs.readdir).mockResolvedValueOnce(entries);
    vi.mocked(fs.stat)
      .mockResolvedValueOnce({ mode: 0o555 } as Stats)
      .mockResolvedValueOnce({ mode: 0o555 } as Stats);

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(vi.mocked(fs.chmod).mock.calls).toEqual([
      [destination, 0o755],
      [join(destination, 'vendor'), 0o755],
    ]);
  });

  it('reuses the same ancestor package to terminate a dependency cycle', async () => {
    const child = join(source, 'child');
    manifests.set(tracer, { dependencies: { child: '1' } });
    manifests.set(child, { dependencies: { 'dd-trace-electron': '1' } });
    resolutions.set(join(tracer, 'package.json'), { child });
    resolutions.set(join(child, 'package.json'), { 'dd-trace-electron': tracer });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.cp).toHaveBeenCalledTimes(3);
  });

  it('walks up from the entry when exports hide the manifest', async () => {
    const rootResolve = createRequire(plugin);
    const resolveRequest = rootResolve.resolve;
    rootResolve.resolve = vi.fn((request: string) => {
      if (request === 'dd-trace-electron/package.json') throw new Error('Not exported');
      if (request === 'dd-trace-electron') return join(tracer, 'dist/index.cjs');
      return resolveRequest(request);
    }) as unknown as NodeRequire['resolve'];
    vi.mocked(fs.access).mockImplementation((file) => {
      return manifests.has(dirname(file as string)) ? Promise.resolve() : Promise.reject(new Error('Missing manifest'));
    });

    await copyRuntimeDependencies(output, rootResolve);

    expect(fs.cp).toHaveBeenCalledWith(tracer, join(staging, 'dd-trace-electron'), expect.anything());
  });

  it('rejects an entry with no package manifest in its ancestors', async () => {
    const rootResolve = createRequire(plugin);
    rootResolve.resolve = vi.fn((request: string) => {
      if (request.endsWith('/package.json')) throw new Error('Not exported');
      return join(tracer, 'index.cjs');
    }) as unknown as NodeRequire['resolve'];
    vi.mocked(fs.access).mockRejectedValue(new Error('No manifest'));

    await expect(copyRuntimeDependencies(output, rootResolve)).rejects.toHaveProperty(
      'cause.message',
      "Cannot find package.json for 'dd-trace-electron'"
    );
  });

  it('refreshes owned directories on rebuild', async () => {
    await copyRuntimeDependencies(output, createRequire(plugin));
    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.rm).toHaveBeenNthCalledWith(4, tracerBackup, {
      recursive: true,
      force: true,
    });
    expect(fs.rename).toHaveBeenCalledWith(
      join(staging, 'dd-trace-electron'),
      join(output, 'node_modules/dd-trace-electron')
    );
    expect(fs.cp).toHaveBeenCalledTimes(4);
  });

  it('keeps optional dependencies excluded', async () => {
    manifests.set(tracer, { optionalDependencies: { absent: '1' } });
    await copyRuntimeDependencies(output, createRequire(plugin));
    expect(fs.cp).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing transitive dependency with its original cause', async () => {
    manifests.set(tracer, { dependencies: { absent: '1' } });
    const copying = copyRuntimeDependencies(output, createRequire(plugin));
    await expect(copying).rejects.toThrow("[datadog] Failed to resolve runtime package 'absent'");
    await expect(copying).rejects.toHaveProperty('cause.message', expect.stringContaining("Cannot find 'absent'"));
  });

  it('rejects a failed copy with its original cause', async () => {
    const cause = new Error('Disk full');
    vi.mocked(fs.cp).mockRejectedValueOnce(cause);
    const copying = copyRuntimeDependencies(output, createRequire(plugin));
    await expect(copying).rejects.toThrow("Failed to copy runtime package 'dd-trace-electron'");
    await expect(copying).rejects.toHaveProperty('cause', cause);
    expect(fs.rename).not.toHaveBeenCalled();
    expect(vi.mocked(fs.rm).mock.calls).toEqual([[staging, { recursive: true, force: true }]]);
  });

  it('leaves all existing output intact when a later package cannot be staged', async () => {
    vi.mocked(fs.cp).mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('Disk full'));

    await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toThrow(
      "Failed to copy runtime package '@datadog/electron-sdk'"
    );

    expect(fs.rename).not.toHaveBeenCalled();
    expect(vi.mocked(fs.rm).mock.calls).toEqual([[staging, { recursive: true, force: true }]]);
  });

  it('copies into an output directory without existing packages', async () => {
    vi.mocked(fs.realpath).mockImplementation((file) => {
      const directory = resolve(String(file));
      return directory.startsWith(output)
        ? Promise.reject(Object.assign(new Error('Missing output'), { code: 'ENOENT' }))
        : Promise.resolve(directory);
    });
    vi.mocked(fs.rename).mockImplementation((from) => {
      return String(from).startsWith(staging + sep)
        ? Promise.resolve()
        : Promise.reject(Object.assign(new Error('No previous output'), { code: 'ENOENT' }));
    });

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect(fs.rename).toHaveBeenCalledTimes(4);
    expect(vi.mocked(fs.rm).mock.calls).toEqual([[staging, { recursive: true, force: true }]]);
  });

  it('rejects an inaccessible destination without changing it', async () => {
    const cause = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    vi.mocked(fs.realpath).mockImplementation((file) => {
      const directory = resolve(String(file));
      return directory.startsWith(output) ? Promise.reject(cause) : Promise.resolve(directory);
    });

    await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toBe(cause);

    expect(fs.rm).not.toHaveBeenCalled();
    expect(fs.cp).not.toHaveBeenCalled();
  });

  it('restores the previous package when moving its replacement fails', async () => {
    const cause = new Error('Rename failed');
    const destination = join(output, 'node_modules/dd-trace-electron');
    const staged = join(staging, 'dd-trace-electron');
    const directories = new Map([
      [destination, 'previous contents'],
      [staged, 'replacement contents'],
    ]);
    vi.mocked(fs.rename).mockImplementation((from, to) => {
      if (from === staged) return Promise.reject(cause);
      directories.set(String(to), directories.get(String(from))!);
      directories.delete(String(from));
      return Promise.resolve();
    });
    vi.mocked(fs.rm).mockImplementation((directory) => {
      for (const path of directories.keys()) {
        if (path === directory || path.startsWith(String(directory) + sep)) directories.delete(path);
      }
      return Promise.resolve();
    });

    const copying = copyRuntimeDependencies(output, createRequire(plugin));
    await expect(copying).rejects.toThrow("Failed to replace runtime package 'dd-trace-electron'");
    await expect(copying).rejects.toHaveProperty('cause', cause);

    expect([...directories]).toEqual([[destination, 'previous contents']]);
    expect(fs.rm).toHaveBeenLastCalledWith(staging, { recursive: true, force: true });
  });

  it('leaves the previous package alone if moving it aside fails', async () => {
    const cause = Object.assign(new Error('Package is busy'), { code: 'EACCES' });
    vi.mocked(fs.rename).mockRejectedValueOnce(cause);

    await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toHaveProperty('cause', cause);

    expect(vi.mocked(fs.rename).mock.calls).toEqual([[join(output, 'node_modules/dd-trace-electron'), tracerBackup]]);
    expect(vi.mocked(fs.rm).mock.calls).toEqual([[staging, { recursive: true, force: true }]]);
  });

  it.each([true, false])(
    'rolls back both roots when installing the SDK fails (previous output: %s)',
    async (hasPreviousOutput) => {
      const cause = new Error('SDK replacement failed');
      const tracerDestination = join(output, 'node_modules/dd-trace-electron');
      const sdkDestination = join(output, 'node_modules/@datadog/electron-sdk');
      const stagedSdk = join(staging, '@datadog/electron-sdk');
      const previous = hasPreviousOutput
        ? ([
            [tracerDestination, 'previous tracer'],
            [sdkDestination, 'previous SDK'],
          ] as const)
        : [];
      const directories = new Map<string, string>([
        ...previous,
        [join(staging, 'dd-trace-electron'), 'new tracer'],
        [stagedSdk, 'new SDK'],
      ]);
      mockDirectories(directories, (from) => (from === stagedSdk ? cause : undefined));

      await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toHaveProperty('cause', cause);

      expect([...directories].sort()).toEqual([...previous].sort());
    }
  );

  it('restores the tracer if moving the previous SDK aside fails', async () => {
    const cause = new Error('SDK is busy');
    const tracerDestination = join(output, 'node_modules/dd-trace-electron');
    const sdkDestination = join(output, 'node_modules/@datadog/electron-sdk');
    const previous = [
      [tracerDestination, 'previous tracer'],
      [sdkDestination, 'previous SDK'],
    ] as const;
    const directories = new Map<string, string>([
      ...previous,
      [join(staging, 'dd-trace-electron'), 'new tracer'],
      [join(staging, '@datadog/electron-sdk'), 'new SDK'],
    ]);
    mockDirectories(directories, (from) => (from === sdkDestination ? cause : undefined));

    await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toHaveProperty('cause', cause);

    expect([...directories].sort()).toEqual([...previous].sort());
  });

  it('continues restoring the tracer if restoring the SDK fails', async () => {
    const copyError = new Error('SDK replacement failed');
    const restoreError = new Error('SDK restoration failed');
    const tracerDestination = join(output, 'node_modules/dd-trace-electron');
    const sdkDestination = join(output, 'node_modules/@datadog/electron-sdk');
    const sdkBackup = join(output, 'node_modules/@datadog/.datadog-runtime-test-electron-sdk-previous');
    const stagedSdk = join(staging, '@datadog/electron-sdk');
    const directories = new Map([
      [tracerDestination, 'previous tracer'],
      [sdkDestination, 'previous SDK'],
      [join(staging, 'dd-trace-electron'), 'new tracer'],
      [stagedSdk, 'new SDK'],
    ]);
    mockDirectories(directories, (from) => {
      if (from === stagedSdk) return copyError;
      if (from === sdkBackup) return restoreError;
      return undefined;
    });

    const copying = copyRuntimeDependencies(output, createRequire(plugin));
    await expect(copying).rejects.toHaveProperty('cause', copyError);
    await expect(copying).rejects.toHaveProperty('restoreErrors.0.cause', restoreError);
    await expect(copying).rejects.toHaveProperty('restoreErrors.0.message', expect.stringContaining(sdkBackup));

    expect([...directories].sort()).toEqual(
      [
        [tracerDestination, 'previous tracer'],
        [sdkBackup, 'previous SDK'],
      ].sort()
    );
  });

  it('replaces both roots and removes their backups after a successful copy', async () => {
    const tracerDestination = join(output, 'node_modules/dd-trace-electron');
    const sdkDestination = join(output, 'node_modules/@datadog/electron-sdk');
    const directories = new Map([
      [tracerDestination, 'previous tracer'],
      [sdkDestination, 'previous SDK'],
      [join(staging, 'dd-trace-electron'), 'new tracer'],
      [join(staging, '@datadog/electron-sdk'), 'new SDK'],
    ]);
    mockDirectories(directories, () => undefined);

    await copyRuntimeDependencies(output, createRequire(plugin));

    expect([...directories].sort()).toEqual(
      [
        [tracerDestination, 'new tracer'],
        [sdkDestination, 'new SDK'],
      ].sort()
    );
  });

  it('retains the backup outside staging and reports both errors if restoration also fails', async () => {
    const copyError = new Error('Replacement failed');
    const restoreError = new Error('Restoration failed');
    vi.mocked(fs.rename)
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(copyError)
      .mockRejectedValueOnce(restoreError);

    const copying = copyRuntimeDependencies(output, createRequire(plugin));
    await expect(copying).rejects.toHaveProperty('cause', copyError);
    await expect(copying).rejects.toHaveProperty('restoreErrors.0.cause', restoreError);
    await expect(copying).rejects.toHaveProperty('restoreErrors.0.message', expect.stringContaining(tracerBackup));

    expect(fs.rename).toHaveBeenLastCalledWith(tracerBackup, join(output, 'node_modules/dd-trace-electron'));
    expect(vi.mocked(fs.rm).mock.calls).toEqual([[staging, { recursive: true, force: true }]]);
  });

  it('rejects a missing runtime root before modifying output', async () => {
    resolutions.get(plugin)!['dd-trace-electron'] = '';

    await expect(copyRuntimeDependencies(output, createRequire(plugin))).rejects.toThrow(
      "Failed to resolve runtime package 'dd-trace-electron'"
    );

    expect(fs.mkdir).not.toHaveBeenCalled();
    expect(fs.rename).not.toHaveBeenCalled();
    expect(fs.rm).not.toHaveBeenCalled();
  });
});

function mockDirectories(
  directories: Map<string, string>,
  renameFailure: (from: string, to: string) => Error | undefined
) {
  vi.mocked(fs.rename).mockImplementation((from, to) => {
    const source = String(from);
    const destination = String(to);
    const failure = renameFailure(source, destination);
    if (failure) return Promise.reject(failure);
    const contents = directories.get(source);
    if (contents === undefined)
      return Promise.reject(Object.assign(new Error('Missing directory'), { code: 'ENOENT' }));
    if (directories.has(destination)) {
      return Promise.reject(Object.assign(new Error('Destination is not empty'), { code: 'ENOTEMPTY' }));
    }
    directories.delete(source);
    directories.set(destination, contents);
    return Promise.resolve();
  });
  vi.mocked(fs.rm).mockImplementation((directory) => {
    for (const path of directories.keys()) {
      if (path === directory || path.startsWith(String(directory) + sep)) directories.delete(path);
    }
    return Promise.resolve();
  });
}
