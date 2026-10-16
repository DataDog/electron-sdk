import { app } from 'electron';

import { resolveBatchSize, resolveUploadFrequency, type Configuration } from '../config';
import type { TrackingConsentManager } from '../domain/tracking-consent';
import { EventKind, EventSource, EventTrack, type EventManager, type ServerEvent } from '../event';
import { BatchManager, BatchMigration, getTrackPath } from './batch';
import type { LogSource } from '../domain/logs';

interface StoreDescriptor {
  trackType: EventTrack;
  logsSource?: LogSource;
  source?: EventSource;
}

const STORES: StoreDescriptor[] = [
  { trackType: EventTrack.RUM },
  { trackType: EventTrack.SPANS },
  { trackType: EventTrack.LOGS, logsSource: 'browser', source: EventSource.RENDERER },
  { trackType: EventTrack.LOGS, logsSource: 'electron', source: EventSource.MAIN },
  { trackType: EventTrack.PROFILE },
  { trackType: EventTrack.REPLAY },
];

/**
 * Orchestrates event transport by routing server events from registered domains
 * through dedicated {@link BatchManager} instances for disk-buffered delivery.
 */
export class Transport {
  private batchManagers: BatchManager[] = [];
  private basePath: string;

  private constructor(
    private readonly config: Configuration,
    private readonly eventManager: EventManager,
    private readonly trackingConsentManager: TrackingConsentManager
  ) {
    this.basePath = app.getPath('userData');
  }

  /** Creates and fully initializes a Transport instance. */
  static async create(
    config: Configuration,
    eventManager: EventManager,
    trackingConsentManager: TrackingConsentManager
  ) {
    const transport = new Transport(config, eventManager, trackingConsentManager);
    // A new process cannot authorize a previous process's undecided data, even for disabled tracks.
    for (const { trackType, logsSource } of STORES) {
      await BatchMigration.clearPendingData(getTrackPath(transport.basePath, trackType, logsSource));
    }
    for (const store of transport.getStores()) {
      await transport.setupStore(store);
    }

    return transport;
  }

  /**
   * Tracks to buffer and upload. The PROFILE track is only set up when profiling can produce data
   * (matching the `profiles` capability gating in RendererPipeline), to avoid idle disk and scheduler
   * work in apps that never enable profiling.
   *
   * Both LOGS sources are unconditional even though many apps never produce logs. Each
   * handler must be ready before RendererPipeline opens the IPC listener because EventManager does not
   * queue unclaimed events. Keeping it active at `logsSampleRate: 0` also lets a later process launch
   * recover and upload logs that were already accepted and persisted under an earlier configuration.
   */
  private getStores(): StoreDescriptor[] {
    return STORES.filter(
      ({ trackType }) =>
        (trackType !== EventTrack.PROFILE || this.config.profilingSampleRate > 0) &&
        (trackType !== EventTrack.REPLAY || this.config.sessionReplaySampleRate > 0)
    );
  }

  /**
   * Creates a {@link BatchManager} configured with the resolved batch size,
   * upload frequency, and storage path for the given track type.
   */
  private async createBatchManager({ trackType, logsSource }: StoreDescriptor) {
    const path = this.basePath;
    const batchSize = resolveBatchSize(this.config);
    const uploadFrequency = resolveUploadFrequency(this.config);

    const manager = await BatchManager.create(
      this.config,
      {
        path,
        trackType,
        batchSize,
        uploadFrequency,
        ...(logsSource === undefined ? {} : { logsSource }),
      },
      this.trackingConsentManager
    );
    this.batchManagers.push(manager);

    return manager;
  }

  /**
   * Create a batch manager for a specific track
   * and register an event handler that forwards matching server events.
   */
  private async setupStore(store: StoreDescriptor) {
    const batchManager = await this.createBatchManager(store);
    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent =>
        event.kind === EventKind.SERVER &&
        event.track === store.trackType &&
        (store.source === undefined || (event.track === EventTrack.LOGS && event.source === store.source)),
      handle: (event) => batchManager.post(event),
    });
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }
}
