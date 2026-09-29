import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { printError, printLog } from './executionUtils.ts';

const defaultRetryDelays = [2_000, 5_000, 10_000, 20_000];
const defaultRequestTimeout = 2 * 60_000;

interface RetryingFetchDownloaderOptions {
  fetchImplementation?: typeof fetch;
  requestTimeout?: number;
  retryDelays?: number[];
}

/** Downloads Electron artifacts with native fetch, retries, and partial-download resumption. */
export class RetryingFetchDownloader {
  private readonly fetchImplementation: typeof fetch;
  private readonly requestTimeout: number;
  private readonly retryDelays: number[];

  constructor(options: RetryingFetchDownloaderOptions = {}) {
    this.fetchImplementation = options.fetchImplementation ?? fetch;
    this.requestTimeout = options.requestTimeout ?? defaultRequestTimeout;
    this.retryDelays = options.retryDelays ?? defaultRetryDelays;
  }

  async download(url: string, targetFilePath: string): Promise<void> {
    const partialFilePath = `${targetFilePath}.partial`;
    fs.mkdirSync(path.dirname(targetFilePath), { recursive: true });

    for (let attempt = 1; attempt <= this.retryDelays.length + 1; attempt += 1) {
      try {
        await this.downloadAttempt(url, targetFilePath, partialFilePath);
        return;
      } catch (error) {
        const delay = this.retryDelays[attempt - 1];
        if (delay === undefined) {
          fs.rmSync(partialFilePath, { force: true });
          throw error;
        }
        printError(`Electron download attempt ${attempt} failed. Retrying in ${delay / 1_000}s.`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async downloadAttempt(url: string, targetFilePath: string, partialFilePath: string): Promise<void> {
    const downloadedBytes = getFileSize(partialFilePath);
    const headers = downloadedBytes > 0 ? { Range: `bytes=${downloadedBytes}-` } : undefined;
    printLog(
      downloadedBytes > 0
        ? `Resuming Electron download at byte ${downloadedBytes}: ${url}`
        : `Downloading Electron artifact with native fetch: ${url}`
    );

    const response = await this.fetchImplementation(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(this.requestTimeout),
    });

    if (response.status === 416 && downloadedBytes > 0) {
      fs.rmSync(partialFilePath, { force: true });
      throw new Error('The Electron artifact server rejected the resumed byte range.');
    }
    if (!response.ok) {
      throw new Error(`Electron artifact request failed with HTTP ${response.status} ${response.statusText}.`);
    }
    if (!response.body) {
      throw new Error('Electron artifact response did not include a body.');
    }

    const resumeAccepted = downloadedBytes > 0 && response.status === 206;
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(partialFilePath, { flags: resumeAccepted ? 'a' : 'w' })
    );
    fs.rmSync(targetFilePath, { force: true });
    fs.renameSync(partialFilePath, targetFilePath);
  }
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch (error) {
    if (isMissingFileError(error)) return 0;
    throw error;
  }
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
