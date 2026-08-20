import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

import { downloadArtifact } from '@electron/get';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { RetryingFetchDownloader } from './retryingFetchDownloader.ts';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('RetryingFetchDownloader', () => {
  it('downloads an artifact using native fetch semantics', async () => {
    const target = createTargetPath();
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response('electron artifact'));
    const downloader = new RetryingFetchDownloader({ fetchImplementation, retryDelays: [] });

    await downloader.download('https://example.test/electron.zip', target);

    expect(fs.readFileSync(target, 'utf8')).toBe('electron artifact');
    expect(fetchImplementation).toHaveBeenCalledWith(
      'https://example.test/electron.zip',
      expect.objectContaining({ redirect: 'follow' })
    );
  });

  it('resumes an existing partial download', async () => {
    const target = createTargetPath();
    const completeArtifact = new TextEncoder().encode('complete electron artifact');
    fs.writeFileSync(`${target}.partial`, completeArtifact.slice(0, 9));
    const fetchImplementation = vi.fn<typeof fetch>((_url, options) => {
      const range = new Headers(options?.headers).get('Range');
      expect(range).toBe('bytes=9-');
      return Promise.resolve(new Response(completeArtifact.slice(9), { status: 206 }));
    });
    const downloader = new RetryingFetchDownloader({ fetchImplementation, retryDelays: [] });

    await downloader.download('https://example.test/electron.zip', target);

    expect(fs.readFileSync(target)).toEqual(Buffer.from(completeArtifact));
    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it('restarts a partial download when the server does not accept byte ranges', async () => {
    const target = createTargetPath();
    fs.writeFileSync(`${target}.partial`, 'stale partial content');
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response('complete artifact'));
    const downloader = new RetryingFetchDownloader({ fetchImplementation, retryDelays: [] });

    await downloader.download('https://example.test/electron.zip', target);

    expect(fs.readFileSync(target, 'utf8')).toBe('complete artifact');
  });

  it('removes a partial download after exhausting retries', async () => {
    const target = createTargetPath();
    const fetchImplementation = vi.fn<typeof fetch>().mockRejectedValue(new Error('network unavailable'));
    const downloader = new RetryingFetchDownloader({ fetchImplementation, retryDelays: [0, 0] });

    await expect(downloader.download('https://example.test/electron.zip', target)).rejects.toThrow(
      'network unavailable'
    );

    expect(fetchImplementation).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(`${target}.partial`)).toBe(false);
  });

  it('integrates with Electron checksum verification and the standard cache', async () => {
    const cacheRoot = createTemporaryDirectory();
    const artifact = Buffer.from('verified electron artifact');
    const filename = 'electron-v99.0.0-linux-x64.zip';
    const checksum = crypto.createHash('sha256').update(artifact).digest('hex');
    const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response(artifact));

    const artifactPath = await downloadArtifact({
      arch: 'x64',
      artifactName: 'electron',
      cacheRoot,
      checksums: { [filename]: checksum },
      downloader: new RetryingFetchDownloader({ fetchImplementation, retryDelays: [] }),
      mirrorOptions: {
        resolveAssetURL: () => Promise.resolve(`https://example.test/${filename}`),
      },
      platform: 'linux',
      version: '99.0.0',
    });

    expect(fs.readFileSync(artifactPath)).toEqual(artifact);
    expect(fetchImplementation).toHaveBeenCalledOnce();

    const cachedArtifactPath = await downloadArtifact({
      arch: 'x64',
      artifactName: 'electron',
      cacheRoot,
      checksums: { [filename]: checksum },
      downloader: new RetryingFetchDownloader({
        fetchImplementation: vi.fn<typeof fetch>().mockRejectedValue(new Error('cache was not used')),
        retryDelays: [],
      }),
      mirrorOptions: {
        resolveAssetURL: () => Promise.resolve(`https://example.test/${filename}`),
      },
      platform: 'linux',
      version: '99.0.0',
    });
    expect(cachedArtifactPath).toBe(artifactPath);
  });
});

function createTargetPath(): string {
  return path.join(createTemporaryDirectory(), 'electron.zip');
}

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-fetch-downloader-'));
  temporaryDirectories.push(directory);
  return directory;
}
