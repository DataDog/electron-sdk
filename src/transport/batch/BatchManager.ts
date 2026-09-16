import path from 'node:path';
import { setTimeout, type Subscription } from '@datadog/browser-core';
import type { TimeStamp } from '@datadog/js-core/time';
import type { Configuration } from '../../config';
import type { TrackingConsentChange, TrackingConsentState } from '../../domain/tracking-consent';
import { addError } from '../../domain/telemetry';
import { EventTrack } from '../../event';
import type { ServerEvent } from '../../event';
import { computeIntakeUrlForTrack } from '../utils';
import { BatchConsumer } from './BatchConsumer';
import type { BatchConsumerConfig } from './BatchConsumer';
import { BatchProducer } from './BatchProducer';
import { ProfileBatchConsumer, ProfileBatchProducer } from './profiling';
import { ReplayBatchConsumer } from './replay/ReplayBatchConsumer';
import { ReplayBatchProducer } from './replay/ReplayBatchProducer';
import { StandardBatchConsumer } from './standard/StandardBatchConsumer';
import { StandardBatchProducer } from './standard/StandardBatchProducer';
import type { StandardBatchProducerConfig } from './standard/StandardBatchProducer';
import type { BatchConfig } from './batchConfig.types';
import { authorizePendingBatches, clearBatchDirectory } from './trackingConsentStorage';

/** Maximum array length accepted by the Logs HTTP intake. */
const MAX_LOGS_EVENTS_PER_BATCH = 1_000;

/**
 * Coordinates a {@link BatchProducer} and {@link BatchConsumer} pair for a single track type.
 * Runs a periodic upload cycle that rotates pending `.tmp` files to `.log` and
 * delivers them to the intake endpoint.
 */
export class BatchManager {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  // The upload cycle currently running (rotate + upload), or null when idle.
  private activeCycle: Promise<void> | null = null;
  // A cycle queued to run after the active one. Concurrent flush() callers coalesce onto it.
  private queuedCycle: Promise<void> | null = null;
  // Consent transitions are reserved synchronously on the pending producer queue in notification order.
  private transitionQueue: Promise<void> = Promise.resolve();
  // Readiness belongs to one pending interval. If its initial clear fails, that interval stays
  // quarantined and can never be authorized by a later grant.
  private pendingStoreReadiness: Promise<boolean> = Promise.resolve(true);
  private pendingAuthorizationReadiness: Promise<boolean> | undefined;
  private trackingConsentSubscription: Subscription | undefined;

  private constructor(
    private readonly authorizedProducer: BatchProducer,
    private readonly pendingProducer: BatchProducer,
    private readonly consumer: BatchConsumer,
    private readonly authorizedPath: string,
    private readonly pendingPath: string,
    private readonly uploadFrequency: number,
    private readonly trackingConsentState?: TrackingConsentState
  ) {
    this.trackingConsentSubscription = trackingConsentState?.beforeObservable.subscribe((change) => {
      this.queueConsentTransition(change);
    });
  }

  /** Creates and fully initializes a BatchManager instance. */
  static async create(config: Configuration, batchConfig: BatchConfig, trackingConsentState?: TrackingConsentState) {
    const { uploadFrequency } = batchConfig;
    const { path: basePath, trackType } = batchConfig;
    // Keep the established authorized paths backward-compatible so batches from older SDK versions
    // are still recovered and uploaded.
    const authorizedPath = path.join(basePath, trackType === EventTrack.LOGS ? 'dd_logs' : trackType);
    const pendingPath = path.join(authorizedPath, 'pending');

    // Like the mobile SDKs, consent is process-local: pending data from a process that ended before a
    // decision is discarded rather than silently authorized by a future launch.
    await clearBatchDirectory(pendingPath);

    const authorizedProducer = await BatchManager.createProducer(batchConfig, authorizedPath);
    const pendingProducer = await BatchManager.createProducer(batchConfig, pendingPath);
    const consumer = BatchManager.createConsumer(config, batchConfig, authorizedPath);
    const manager = new BatchManager(
      authorizedProducer,
      pendingProducer,
      consumer,
      authorizedPath,
      pendingPath,
      uploadFrequency,
      trackingConsentState
    );
    manager.start();

    return manager;
  }

  /** Enqueues a server event to be written to the current batch file. */
  post(event: ServerEvent) {
    const captureTime = event.consentTime ?? getServerEventCaptureTime(event);
    const consent =
      captureTime === undefined
        ? (this.trackingConsentState?.get() ?? 'granted')
        : (this.trackingConsentState?.resolveForStorage(captureTime) ?? 'not-granted');
    if (consent === 'granted') {
      this.authorizedProducer.post(event);
    } else if (consent === 'pending') {
      this.pendingProducer.post(event);
    }
  }

  /**
   * Drains the write queue, rotates the current batch, and uploads all pending files.
   *
   * Guarantees a full cycle runs to completion *after* this call. A scheduled cycle already in
   * flight may have scanned the directory before the caller rotated new files (e.g. the final
   * replay segment flushed on quit), so we always run a fresh cycle behind it rather than
   * short-circuiting — otherwise those files would sit on disk until the next launch.
   */
  async flush() {
    await this.enqueueUploadCycle();
  }

  /** Stops the periodic upload cycle. */
  stop() {
    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
    this.trackingConsentSubscription?.unsubscribe();
    this.trackingConsentSubscription = undefined;
  }

  /** Kicks off the first scheduled cycle. */
  private start() {
    this.scheduleNext();
  }

  /** Schedules the next upload cycle after the configured frequency delay. */
  private scheduleNext() {
    this.timeoutId = setTimeout(() => {
      void this.runPeriodicCycle()
        .catch((error) => addError(error))
        .then(() => this.scheduleNext());
    }, this.uploadFrequency);
  }

  /**
   * Periodic tick: run a cycle only when nothing is active or queued, so ticks never stack up
   * behind a slow upload (a fresh tick will fire next interval anyway).
   */
  private runPeriodicCycle(): Promise<void> {
    if (this.activeCycle || this.queuedCycle) {
      return this.activeCycle ?? Promise.resolve();
    }
    return this.enqueueUploadCycle();
  }

  /**
   * Queues an upload cycle to run after any in-flight one. Multiple callers before the queued
   * cycle starts share the same promise, so at most one cycle is ever pending and cycles never
   * overlap (rotate + upload touch the same directory).
   */
  private enqueueUploadCycle(): Promise<void> {
    if (this.queuedCycle) {
      return this.queuedCycle;
    }

    const previous = this.activeCycle ?? Promise.resolve();
    const cycle = previous
      // Swallow the prior cycle's failure — its own scheduler already reported it, and this
      // cycle must still run so newly rotated files get uploaded.
      .catch(() => undefined)
      .then(() => {
        this.queuedCycle = null;
        this.activeCycle = this.runUploadCycle();
        return this.activeCycle;
      });
    this.queuedCycle = cycle;
    return cycle;
  }

  /** Flushes both isolated producers, authorizes explicitly granted pending files, then uploads authorized batches. */
  private async runUploadCycle() {
    // Capture the queue at cycle start. A transition arriving during this cycle is already ordered on the
    // pending producer; the next requested cycle will await it too.
    const transitionsBeforeCycle = this.transitionQueue;
    try {
      await transitionsBeforeCycle;
      await this.authorizedProducer.flush();
      const authorizationReadiness = this.pendingAuthorizationReadiness;
      if (authorizationReadiness) {
        await this.pendingProducer.runAfterFlush(() => this.authorizePendingStore(authorizationReadiness));
        if (this.pendingAuthorizationReadiness === authorizationReadiness) {
          this.pendingAuthorizationReadiness = undefined;
        }
      } else {
        await this.pendingProducer.flush();
      }
      // Previously authorized data remains uploadable after consent changes, matching iOS and Android.
      await this.consumer.upload();
    } finally {
      this.activeCycle = null;
    }
  }

  private queueConsentTransition(change: TrackingConsentChange): void {
    let reservedStorageOperation: Promise<void> | undefined;

    if (change.previous === 'pending' && change.current === 'granted') {
      const authorizationReadiness = this.pendingStoreReadiness;
      this.pendingAuthorizationReadiness = authorizationReadiness;
      // Reserve rotation + migration immediately. A subsequent transition back to pending queues its
      // clear behind this operation, so accepted events cannot be deleted before being authorized.
      reservedStorageOperation = this.pendingProducer
        .runAfterFlush(() => this.authorizePendingStore(authorizationReadiness))
        .then(() => {
          if (this.pendingAuthorizationReadiness === authorizationReadiness) {
            this.pendingAuthorizationReadiness = undefined;
          }
        });
    } else if (change.current === 'pending') {
      this.pendingAuthorizationReadiness = undefined;
      // Reserve deletion immediately; posts following the synchronous state notification queue behind it.
      reservedStorageOperation = this.pendingProducer.clear();
      this.pendingStoreReadiness = reservedStorageOperation.then(
        () => true,
        () => false
      );
    } else if (change.previous === 'pending' && change.current === 'not-granted') {
      this.pendingAuthorizationReadiness = undefined;
      reservedStorageOperation = this.pendingProducer.clear();
    }

    const previousTransition = this.transitionQueue;
    const transition = previousTransition
      .catch(() => undefined)
      .then(async () => {
        await reservedStorageOperation;
      });

    this.transitionQueue = transition.catch((error) => {
      addError(error);
    });
  }

  private async authorizePendingStore(readiness: Promise<boolean>): Promise<void> {
    if (await readiness) {
      await authorizePendingBatches(this.pendingPath, this.authorizedPath);
    }
  }

  /**
   * Creates the appropriate {@link BatchProducer} / {@link BatchConsumer} pair for the
   * given track type. Add a new branch here when introducing a new transport strategy.
   *
   * Each producer narrows `writeData()` to its track's event shape, so a mismatched pairing
   * fails only at runtime. Keep each branch in sync with `Transport.setupTrackBatching`.
   */
  private static async createProducer(batchConfig: BatchConfig, trackPath: string): Promise<BatchProducer> {
    const { trackType, batchSize } = batchConfig;
    if (trackType === EventTrack.REPLAY) {
      return ReplayBatchProducer.create({ trackPath });
    }

    if (trackType === EventTrack.PROFILE) {
      return ProfileBatchProducer.create({ trackPath });
    }

    const standardProducerConfig: StandardBatchProducerConfig = {
      trackPath,
      batchSize,
      ...(trackType === EventTrack.LOGS ? { maxEventsPerBatch: MAX_LOGS_EVENTS_PER_BATCH } : {}),
    };
    return StandardBatchProducer.create(standardProducerConfig);
  }

  private static createConsumer(config: Configuration, batchConfig: BatchConfig, trackPath: string): BatchConsumer {
    const { clientToken } = config;
    const { trackType } = batchConfig;
    const intakeUrl = computeIntakeUrlForTrack(config.site, trackType, { proxy: config.proxy });
    const consumerConfig: BatchConsumerConfig = { trackPath, intakeUrl, clientToken };

    if (trackType === EventTrack.REPLAY) {
      return new ReplayBatchConsumer(consumerConfig);
    }
    if (trackType === EventTrack.PROFILE) {
      return new ProfileBatchConsumer(consumerConfig);
    }
    return new StandardBatchConsumer(consumerConfig);
  }
}

function getServerEventCaptureTime(event: ServerEvent): TimeStamp | undefined {
  switch (event.track) {
    case EventTrack.RUM:
    case EventTrack.LOGS: {
      const date = (event.data as { date?: unknown }).date;
      return typeof date === 'number' && Number.isFinite(date) ? (date as TimeStamp) : undefined;
    }
    case EventTrack.SPANS: {
      const starts = Array.isArray(event.data.spans)
        ? event.data.spans.map((span) => span.start / 1e6).filter(Number.isFinite)
        : [];
      return starts.length > 0 ? (Math.min(...starts) as TimeStamp) : undefined;
    }
    case EventTrack.PROFILE: {
      const start = new Date(event.data.start).getTime();
      return Number.isFinite(start) ? (start as TimeStamp) : undefined;
    }
    case EventTrack.REPLAY: {
      const start = event.data.metadata.start;
      return Number.isFinite(start) ? (start as TimeStamp) : undefined;
    }
  }
}
