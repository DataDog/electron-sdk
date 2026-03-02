import { app } from 'electron';

import { BatchSizes, BatchUploadFrequencies, type Configuration } from '../config';
import { EventKind, type EventManager, type ServerEvent } from '../event';
import { BatchManager } from './batch';
import type { Domain, TrackType } from './transport.types';

/**
 * Orchestrates event transport by routing server events from registered domains
 * through dedicated {@link BatchManager} instances for disk-buffered delivery.
 */
export class Transport {
  private domains = new Map<string, Domain>();
  private batchManagers: BatchManager[] = [];
  private basePath: string;

  constructor(
    private readonly config: Configuration,
    private readonly eventManager: EventManager,
    domains: Domain[] = [],
    customPath?: string
  ) {
    this.basePath = customPath ?? app.getPath('userData');

    for (const domain of domains) {
      this.register(domain);
    }
  }

  /**
   * Creates a {@link BatchManager} configured with the resolved batch size,
   * upload frequency, and storage path for the given track type.
   */
  private createBatchManager(trackType: TrackType) {
    const path = this.basePath;
    const batchSize = this.config.batchSize ? BatchSizes[this.config.batchSize] : BatchSizes.MEDIUM;
    const uploadFrequency = this.config.uploadFrequency
      ? BatchUploadFrequencies[this.config.uploadFrequency]
      : BatchUploadFrequencies.NORMAL;

    const manager = new BatchManager(this.config, {
      path,
      trackType,
      batchSize,
      uploadFrequency,
    });
    this.batchManagers.push(manager);

    return manager;
  }

  /**
   * Wires a domain into the event pipeline by creating its batch manager
   * and registering an event handler that forwards matching server events.
   */
  private async setupDomainBatching(domain: Domain) {
    const batchManager = this.createBatchManager(domain.trackType);

    this.eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER && event.track === domain.trackType,
      handle: (event) => {
        batchManager.post(event.data);
      },
    });

    await batchManager.init();
  }

  /** Registers a domain for transport. Duplicate track types are ignored. */
  register(domain: Domain) {
    if (this.domains.has(domain.trackType)) {
      return;
    }

    this.domains.set(domain.trackType, domain);
  }

  /** Initializes batch managers and event handlers for all registered domains. */
  async init() {
    for (const domain of this.domains.values()) {
      await this.setupDomainBatching(domain);
      domain.init();
    }
  }

  /** Flushes all batch managers, rotating pending data and triggering uploads. */
  async flush() {
    await Promise.all(this.batchManagers.map((m) => m.flush()));
  }
}
