import fs from 'node:fs/promises';
import { BatchProducer } from '../BatchProducer';
import type { BatchProducerConfig } from '../BatchProducer';

/**
 * Concrete {@link BatchProducer} that serializes events as newline-delimited JSON
 * and appends them to `.tmp` batch files on disk.
 */
export class StandardBatchProducer extends BatchProducer {
  /**
   * Creates and fully initializes a StandardBatchProducer.
   * Ensures the track directory exists and rotates any orphaned `.tmp` files
   * left from previous sessions.
   */
  static async create(config: BatchProducerConfig): Promise<BatchProducer> {
    const producer = new StandardBatchProducer(config);
    await producer.ensureTrackDirectoryExists();
    await producer.rotateOrphanedBatches();

    return producer;
  }

  /** Serializes data as a JSON line and appends it to the current batch file, rotating first if the size limit would be exceeded. */
  async writeData(data: unknown) {
    await this.ensureTrackDirectoryExists();

    const serialized = `${JSON.stringify(data)}\n`;
    const dataSize = Buffer.byteLength(serialized, 'utf8');

    if (this.currentBatchSize + dataSize > this.batchSize && this.currentBatchSize > 0) {
      await this.rotateBatch();
    }

    const batchPath = this.getCurrentBatchPath();
    await fs.appendFile(batchPath, serialized, 'utf8');
    this.currentBatchSize += dataSize;
  }
}
