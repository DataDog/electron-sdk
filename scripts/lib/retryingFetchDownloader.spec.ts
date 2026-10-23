import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RetryingFetchDownloader } from './retryingFetchDownloader.ts';

let directory: string;
let destination: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), 'electron-download-'));
  destination = path.join(directory, 'electron.zip');
});

afterEach(() => {
  fs.rmSync(directory, { recursive: true, force: true });
});

it('resumes an interrupted download and publishes the complete bytes', async () => {
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('first'));
          },
          async pull(controller) {
            // Interrupt only after the bytes reach disk, so the retry has something to resume.
            await vi.waitFor(() => expect(fs.readFileSync(`${destination}.partial`, 'utf8')).toBe('first'));
            controller.error(new Error('Connection interrupted'));
          },
        })
      )
    )
    .mockImplementationOnce((_url, options) => {
      expect(options?.headers).toEqual({ Range: 'bytes=5-' });
      expect(fs.existsSync(destination)).toBe(false);
      return Promise.resolve(new Response('-second', { status: 206 }));
    });

  await new RetryingFetchDownloader({ fetchImplementation, retryDelays: [0] }).download(
    'https://example.com/electron.zip',
    destination
  );

  expect(fs.readFileSync(destination, 'utf8')).toBe('first-second');
  expect(fs.existsSync(`${destination}.partial`)).toBe(false);
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
});

it('replaces partial bytes when the server ignores the Range header', async () => {
  fs.writeFileSync(`${destination}.partial`, 'old-partial');
  const fetchImplementation = vi.fn<typeof fetch>().mockResolvedValue(new Response('complete', { status: 200 }));

  await new RetryingFetchDownloader({ fetchImplementation, retryDelays: [] }).download(
    'https://example.com/electron.zip',
    destination
  );

  expect(fetchImplementation.mock.calls[0][1]?.headers).toEqual({ Range: 'bytes=11-' });
  expect(fs.readFileSync(destination, 'utf8')).toBe('complete');
});

it('restarts without a range after HTTP 416', async () => {
  fs.writeFileSync(`${destination}.partial`, 'partial');
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockResolvedValueOnce(new Response(null, { status: 416 }))
    .mockImplementationOnce((_url, options) => {
      expect(options?.headers).toBeUndefined();
      expect(fs.existsSync(`${destination}.partial`)).toBe(false);
      return Promise.resolve(new Response('complete'));
    });

  await new RetryingFetchDownloader({ fetchImplementation, retryDelays: [0] }).download(
    'https://example.com/electron.zip',
    destination
  );

  expect(fetchImplementation.mock.calls[0][1]?.headers).toEqual({ Range: 'bytes=7-' });
  expect(fs.readFileSync(destination, 'utf8')).toBe('complete');
  expect(fetchImplementation).toHaveBeenCalledTimes(2);
});

it('rejects after exhausting retries and removes partial output without replacing an existing file', async () => {
  fs.writeFileSync(destination, 'previous-download');
  fs.writeFileSync(`${destination}.partial`, 'partial');
  const fetchImplementation = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(null, { status: 503 })));

  await expect(
    new RetryingFetchDownloader({ fetchImplementation, retryDelays: [0, 0] }).download(
      'https://example.com/electron.zip',
      destination
    )
  ).rejects.toThrow('HTTP 503');

  expect(fetchImplementation).toHaveBeenCalledTimes(3);
  expect(fs.existsSync(`${destination}.partial`)).toBe(false);
  expect(fs.readFileSync(destination, 'utf8')).toBe('previous-download');
});

it('aborts stalled requests on each attempt and cleans up after the final timeout', async () => {
  fs.writeFileSync(`${destination}.partial`, 'partial');
  const fetchImplementation = vi.fn<typeof fetch>().mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) => {
        const signal = options!.signal!;
        signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true });
      })
  );

  await expect(
    new RetryingFetchDownloader({ fetchImplementation, requestTimeout: 10, retryDelays: [0] }).download(
      'https://example.com/electron.zip',
      destination
    )
  ).rejects.toMatchObject({ name: 'TimeoutError' });

  expect(fetchImplementation).toHaveBeenCalledTimes(2);
  expect(fs.existsSync(`${destination}.partial`)).toBe(false);
  expect(fs.existsSync(destination)).toBe(false);
});
