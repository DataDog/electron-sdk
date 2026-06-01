import path from 'node:path';
import type { Configuration } from '../../config';
import { computeIntakeUrlForTrack } from '../utils';
import { GenericBatchConsumer } from './generic/GenericBatchConsumer';
import { GenericBatchProducer } from './generic/GenericBatchProducer';
import type { BatchConsumerConfig, BatchConfig, BatchProducerConfig } from './types';
import type { BatchConsumer } from './BatchConsumer';
import type { BatchProducer } from './BatchProducer';

/**
 * Factory that creates a matched {@link BatchProducer} / {@link BatchConsumer} pair
 * for a given track type and configuration.
 *
 * Add a new `create*Batch` private method here when introducing a new transport
 * strategy (e.g. session replay, profiling) and dispatch to it from {@link create}.
 */
export class BatchFactory {
  /**
   * Creates and initializes the appropriate producer/consumer pair for the given
   * {@link BatchConfig.trackType}.
   */
  static async create(
    config: Configuration,
    batchConfig: BatchConfig
  ): Promise<{ producer: BatchProducer; consumer: BatchConsumer }> {
    const { clientToken } = config;
    const { path: configPath, trackType, batchSize } = batchConfig;

    const trackPath = path.join(configPath, trackType);
    const intakeUrl = computeIntakeUrlForTrack(config.site, trackType, config.proxy);

    // TODO: handle other batch types (e.g. session replay)
    return BatchFactory.createGenericBatch({ trackPath, batchSize }, { trackPath, intakeUrl, clientToken });
  }

  /**
   * Builds a JSON-NDJSON producer paired with a JSON-array-POST consumer.
   * Used for standard event tracks (RUM, logs, etc.).
   */
  private static async createGenericBatch(
    producerConfig: BatchProducerConfig,
    consumerConfig: BatchConsumerConfig
  ): Promise<{ producer: BatchProducer; consumer: BatchConsumer }> {
    const producer = await GenericBatchProducer.create(producerConfig);
    const consumer = new GenericBatchConsumer(consumerConfig);

    return { producer, consumer };
  }
}
