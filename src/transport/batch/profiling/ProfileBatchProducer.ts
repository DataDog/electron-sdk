import { dateNow } from '@datadog/browser-core';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { BrowserProfileEvent, BrowserProfilerTrace } from '../../../event';

export interface ProfileData {
  event: BrowserProfileEvent;
  trace: BrowserProfilerTrace;
}

export class ProfileBatchProducer {
  private writeQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly trackPath: string) {}

  static async create(trackPath: string): Promise<ProfileBatchProducer> {
    const producer = new ProfileBatchProducer(trackPath);
    await producer.ensureDirectoryExists();
    await producer.rotateOrphanedFiles();
    return producer;
  }

  post(data: ProfileData): void {
    this.writeQueue = this.writeQueue
      .then(() => this.writeFile(data))
      .catch(() => {
        // silently ignore write errors so the queue continues processing
      });
  }

  private async writeFile(data: ProfileData): Promise<void> {
    await this.ensureDirectoryExists();
    const baseName = `profile-${dateNow()}`;
    const tmpPath = path.join(this.trackPath, `${baseName}.tmp`);
    const logPath = path.join(this.trackPath, `${baseName}.log`);
    const content = `${JSON.stringify(data.event)}\n${JSON.stringify(data.trace)}\n`;
    await fs.writeFile(tmpPath, content, 'utf8');
    await fs.rename(tmpPath, logPath);
  }

  private async ensureDirectoryExists(): Promise<void> {
    try {
      await fs.access(this.trackPath);
    } catch {
      await fs.mkdir(this.trackPath, { recursive: true });
    }
  }

  private async rotateOrphanedFiles(): Promise<void> {
    try {
      const files = await fs.readdir(this.trackPath);
      for (const file of files) {
        if (file.endsWith('.tmp')) {
          const tmpPath = path.join(this.trackPath, file);
          const logPath = tmpPath.replace(/\.tmp$/, '.log');
          try {
            await fs.rename(tmpPath, logPath);
          } catch {
            // ignore
          }
        }
      }
    } catch {
      // directory unreadable — nothing to rotate
    }
  }
}
