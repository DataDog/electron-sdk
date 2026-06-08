import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { getUserAgent } from '../../userAgent';

export interface ProfileConsumerConfig {
  trackPath: string;
  intakeUrl: string;
  clientToken: string;
}

export class ProfileBatchConsumer {
  private userAgent: string | undefined;

  constructor(private readonly config: ProfileConsumerConfig) {}

  async upload(): Promise<void> {
    if (!this.userAgent) {
      this.userAgent = getUserAgent();
    }

    const files = await this.getLogFiles();
    for (const file of files) {
      await this.uploadFile(file);
    }
  }

  private async getLogFiles(): Promise<string[]> {
    try {
      await fs.access(this.config.trackPath);
      const entries = await fs.readdir(this.config.trackPath);
      return entries
        .filter((f) => f.endsWith('.log'))
        .sort()
        .map((f) => path.join(this.config.trackPath, f));
    } catch {
      return [];
    }
  }

  private async uploadFile(filePath: string): Promise<void> {
    let content: string;
    try {
      content = await fs.readFile(filePath, 'utf8');
    } catch {
      return;
    }

    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    if (lines.length < 2) {
      try {
        await fs.unlink(filePath);
      } catch {
        /* ignore */
      }
      return;
    }

    const eventJson = lines[0];
    const traceJson = lines[1];

    let compressed: Buffer;
    try {
      compressed = await this.deflate(Buffer.from(traceJson));
    } catch {
      return;
    }

    const formData = new FormData();
    formData.append('event', new Blob([eventJson], { type: 'application/json' }), 'event.json');
    formData.append('wall-time.json', new Blob([compressed]), 'wall-time.json');

    try {
      const response = await fetch(this.config.intakeUrl, {
        method: 'POST',
        headers: {
          'DD-API-KEY': this.config.clientToken,
          'User-Agent': this.userAgent!,
        },
        body: formData,
      });

      if (response.ok) {
        await fs.unlink(filePath);
      }
    } catch {
      // leave file for retry
    }
  }

  private deflate(data: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      zlib.deflate(data, (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    });
  }
}
