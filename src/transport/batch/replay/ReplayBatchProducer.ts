import fs from 'node:fs/promises';
import path from 'node:path';
import { BatchProducer } from '../BatchProducer';
import type { BatchProducerConfig } from '../BatchProducer';
import type { ReplaySegmentPayload } from '../../../domain/replay';

/**
 * Concrete {@link BatchProducer} for session replay segments.
 *
 * Unlike the standard producer, each call to {@link writeData} writes one
 * complete, atomic file per segment (no append/rotation by size). Each file
 * contains two lines:
 *   - Line 1: JSON metadata + size fields (consumed by the multipart 'event' part)
 *   - Line 2: base64-encoded compressed segment binary (the multipart 'blob' part)
 *
 * The `.tmp` → `.log` rename ensures atomicity: the consumer never reads a
 * partially-written segment.
 */
export class ReplayBatchProducer extends BatchProducer {
  /** Creates and fully initializes a ReplayBatchProducer. */
  static async create(config: BatchProducerConfig): Promise<ReplayBatchProducer> {
    const producer = new ReplayBatchProducer(config);
    await producer.initialize();
    return producer;
  }

  protected async writeData(data: unknown): Promise<void> {
    const { metadata, rawBytesCount, compressed } = data as ReplaySegmentPayload;

    await this.ensureTrackDirectoryExists();

    const fileName = this.generateBatchFileName();
    const tmpPath = path.join(this.trackPath, fileName);

    const metadataWithSizes = {
      ...metadata,
      raw_segment_size: rawBytesCount,
      compressed_segment_size: compressed.byteLength,
    };

    const content = `${JSON.stringify(metadataWithSizes)}\n${compressed.toString('base64')}\n`;
    await fs.writeFile(tmpPath, content, 'utf8');
    await this.renameBatchFile(fileName);
  }
}
