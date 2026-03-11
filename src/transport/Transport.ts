import { app } from 'electron';

import { BatchSizes, BatchUploadFrequencies, type Configuration } from '../config';
import { EventKind, EventTrack, type EventManager, type ServerEvent } from '../event';
import { BatchManager } from './batch';

/**
 * Orchestrates event transport by routing server events from registered domains
 * through dedicated {@link BatchManager} instances for disk-buffered delivery.
 */
export class Transport {
  private tracks: EventTrack[] = [EventTrack.RUM];
  private batchManagers: BatchManager[] = [];
  private basePath: string;

  private constructor(
    private readonly config: Configuration,
    private readonly eventManager: EventManager
  ) {
    this.basePath = app.getPath('userData');
  }

  /** Creates and fully initializes a Transport instance. */
  static async create(config: Configuration, eventManager: EventManager) {
    const transport = new Transport(config, eventManager);
    for (const track of transport.tracks) {
      await transport.setupTrackBatching(track);
    }

    return transport;
  }

  /**
   * Creates a {@link BatchManager} configured with the resolved batch size,
   * upload frequency, and storage path for the given track type.
   */
  private async createBatchManager(trackType: EventTrack) {
    const path = this.basePath;
    const batchSize = this.config.batchSize ? BatchSizes[this.config.batchSize] : BatchSizes.MEDIUM;
    const uploadFrequency = this.config.uploadFrequency
      ? BatchUploadFrequencies[this.config.uploadFrequency]
      : BatchUploadFrequencies.NORMAL;

    const manager = await BatchManager.create(this.config, {
      path,
      trackType,
      batchSize,
      uploadFrequency,
    });
    this.batchManagers.push(manager);

    return manager;
  }

  /**
   * Create a batch manager for a specific track
   * and register an event handler that forwards matching server events.
   */
  private async setupTrackBatching(track: EventTrack) {
    const batchManager = await this.createBatchManager(track);

    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER && event.track === track,
      handle: (event) => {
        batchManager.post(event.data);
      },
    });
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }
}
