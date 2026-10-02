import * as fs from 'node:fs/promises';
import { monitor, setTimeout } from '../domain/telemetry';
import { display } from './display';

const MAX_WRITE_ATTEMPTS = 3;
const WRITE_RETRY_DELAY = 100;

/** Loads JSON and serializes snapshot writes, retrying failures before advancing the queue. */
export class DiskStorage<T> {
  private pendingWrite: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<T | undefined> {
    try {
      return JSON.parse(await fs.readFile(this.filePath, 'utf-8')) as T;
    } catch {
      // Missing or unreadable history must not supply context to an event.
      return undefined;
    }
  }

  save(value: T): void {
    // Capture before queuing: callers can continue changing the in-memory history.
    const snapshot = JSON.stringify(value);
    this.pendingWrite = this.pendingWrite.then(
      monitor(async () => {
        // Keep retries in the same queue slot so newer snapshots are always written last.
        for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt++) {
          try {
            await fs.writeFile(this.filePath, snapshot, 'utf-8');
            return;
          } catch (error) {
            if (attempt === MAX_WRITE_ATTEMPTS) {
              display.error('Failed to persist context history:', error);
              return;
            }
            await new Promise<void>((resolve) => setTimeout(resolve, WRITE_RETRY_DELAY).unref());
          }
        }
      })
    );
  }
}
