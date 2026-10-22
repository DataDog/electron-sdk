import fs from 'node:fs/promises';
import path from 'node:path';
import type { ServerProfileEvent } from '../../../event';
import { BatchProducer } from '../BatchProducer';
import type { BatchProducerConfig } from '../BatchProducer';

/**
 * Concrete {@link BatchProducer} that writes one profile per file as two newline-delimited
 * JSON lines (`event` then `trace`). Each profile is a complete batch, so the `.tmp` file is
 * renamed to `.log` immediately after writing rather than being held open for size-based rotation.
 */
export class ProfileBatchProducer extends BatchProducer {
  protected override fileNamePrefix = 'profile';

  private constructor(config: BatchProducerConfig) {
    super(config);
  }

  /**
   * Creates and fully initializes a ProfileBatchProducer.
   * Ensures the track directory exists and rotates any orphaned `.tmp` files
   * left from previous sessions.
   */
  static async create(config: BatchProducerConfig): Promise<BatchProducer> {
    const producer = new ProfileBatchProducer(config);
    await producer.initialize();
    return producer;
  }

  /** Serializes the profile as two JSON lines (`event` then `trace`) and writes it as a complete `.log` batch. */
  protected async writeData(event: ServerProfileEvent) {
    await this.ensureTrackDirectoryExists();

    const fileName = this.generateBatchFileName();
    const tmpPath = path.join(this.trackPath, fileName);
    const content = `${JSON.stringify(event.data)}\n${JSON.stringify(event.trace)}\n`;

    await fs.writeFile(tmpPath, content, 'utf8');
    await this.renameBatchFile(fileName);
  }
}
