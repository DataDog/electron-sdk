import { app } from 'electron';
import path from 'node:path';

import { resolveBatchSize, resolveUploadFrequency, type Configuration } from '../config';
import type { TrackingConsentManager } from '../domain/tracking-consent';
import { EventKind, EventSource, EventTrack, type EventManager, type ServerEvent } from '../event';
import { BatchManager, BatchMigration } from './batch';
import type { PathScrubber } from '../tools/pathScrubber';

type StoreDescriptor =
  | { trackType: typeof EventTrack.LOGS; source: EventSource; directory: string; intakeSource: 'browser' | 'electron' }
  | { trackType: Exclude<EventTrack, typeof EventTrack.LOGS>; directory: string; intakeSource: 'electron' };

// Renaming a directory requires a migration so persisted batches remain available after an upgrade.
const STORES: StoreDescriptor[] = [
  { trackType: EventTrack.RUM, directory: EventTrack.RUM, intakeSource: 'electron' },
  { trackType: EventTrack.SPANS, directory: EventTrack.SPANS, intakeSource: 'electron' },
  { trackType: EventTrack.LOGS, source: EventSource.RENDERER, directory: 'dd_logs', intakeSource: 'browser' },
  { trackType: EventTrack.LOGS, source: EventSource.MAIN, directory: 'dd_main_logs', intakeSource: 'electron' },
  { trackType: EventTrack.PROFILE, directory: EventTrack.PROFILE, intakeSource: 'electron' },
  { trackType: EventTrack.REPLAY, directory: EventTrack.REPLAY, intakeSource: 'electron' },
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
    private readonly trackingConsentManager: TrackingConsentManager,
    private readonly pathScrubber: Pick<PathScrubber, 'scrub'>
  ) {
    this.basePath = app.getPath('userData');
  }

  /** Creates and fully initializes a Transport instance. */
  static async create(
    config: Configuration,
    eventManager: EventManager,
    trackingConsentManager: TrackingConsentManager,
    pathScrubber: Pick<PathScrubber, 'scrub'>
  ) {
    const transport = new Transport(config, eventManager, trackingConsentManager, pathScrubber);
    // A new process cannot authorize a previous process's undecided data, even for disabled tracks.
    for (const store of STORES) {
      await BatchMigration.clearPendingData(path.join(transport.basePath, store.directory));
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
  private async createBatchManager(store: StoreDescriptor) {
    const batchSize = resolveBatchSize(this.config);
    const uploadFrequency = resolveUploadFrequency(this.config);

    const manager = await BatchManager.create(
      this.config,
      {
        trackPath: path.join(this.basePath, store.directory),
        trackType: store.trackType,
        batchSize,
        uploadFrequency,
        intakeSource: store.intakeSource,
      },
      this.trackingConsentManager,
      this.pathScrubber
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
        (store.trackType !== EventTrack.LOGS || (event.track === EventTrack.LOGS && event.source === store.source)),
      handle: (event) => batchManager.post(event),
    });
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }
}
