import * as fs from 'node:fs/promises';
import { monitor } from '../domain/telemetry';
import { display } from './display';

/** Loads a JSON value and serializes writes so an older snapshot cannot overwrite a newer one. */
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
        try {
          await fs.writeFile(this.filePath, snapshot, 'utf-8');
        } catch (error) {
          display.error('Failed to persist context history:', error);
        }
      })
    );
  }
}
