import path from 'node:path';
import type { Configuration } from '../../config';
import { EventTrack } from '../../event';
import { computeIntakeUrlForTrack } from '../utils';
import { GenericBatchConsumer } from './generic/GenericBatchConsumer';
import { GenericBatchProducer } from './generic/GenericBatchProducer';
import { ReplayBatchConsumer } from './replay/ReplayBatchConsumer';
import { ReplayBatchProducer } from './replay/ReplayBatchProducer';
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

    const producerConfig: BatchProducerConfig = { trackPath, batchSize };
    const consumerConfig: BatchConsumerConfig = { trackPath, intakeUrl, clientToken };

    if (trackType === EventTrack.REPLAY) {
      return BatchFactory.createReplayBatch(producerConfig, consumerConfig);
    }

    return BatchFactory.createGenericBatch(producerConfig, consumerConfig);
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

  /**
   * Builds a replay producer (one atomic file per compressed segment) paired with
   * a multipart/form-data consumer for the session replay intake.
   */
  private static async createReplayBatch(
    producerConfig: BatchProducerConfig,
    consumerConfig: BatchConsumerConfig
  ): Promise<{ producer: BatchProducer; consumer: BatchConsumer }> {
    const producer = await ReplayBatchProducer.create(producerConfig);
    const consumer = new ReplayBatchConsumer(consumerConfig);

    return { producer, consumer };
  }
}
