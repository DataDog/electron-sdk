import { ONE_SECOND } from '@datadog/browser-core';
import { EventFormat, EventKind, EventTrack, LifecycleKind } from '../../event';
import type { EventManager, RawReplayEvent, LifecycleEvent } from '../../event';
import type { Configuration } from '../../config';
import type { SessionManager } from '../session';
import { monitor } from '../telemetry';
import { Segment, type BrowserRecord, type CreationReason, type SegmentContext } from './Segment';
import { StreamingDeflate } from './StreamingDeflate';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';

const SEGMENT_DURATION_LIMIT = 5 * ONE_SECOND;
const SEGMENT_BYTES_LIMIT = 60_000;

/**
 * Orchestrates session replay segment collection in the main process.
 *
 * Listens for individual BrowserRecord events from renderer processes (via
 * the bridge), buffers them into {@link Segment} objects with proper context,
 * and emits compressed {@link ServerReplayEvent}s for the transport layer to
 * persist and upload.
 *
 * Segments are flushed when:
 * - Duration limit (5s) is reached
 * - Estimated byte size limit (60KB) is exceeded
 * - The renderer view changes (different view.id)
 * - The session expires or renews
 */
export interface ViewReplayStats {
  segments_count: number;
  segments_total_raw_size: number;
}

export class ReplayCollection {
  private segment: Segment | null = null;
  private currentViewId: string | undefined;
  private nextCreationReason: CreationReason = 'init';
  private segmentIndexPerView = new Map<string, number>();
  private viewReplayStats = new Map<string, ViewReplayStats>();
  private flushTimeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
  // One persistent deflate stream per session — required so the backend can
  // stitch all segments into a single valid ZLIB stream for the replay player.
  private deflate = new StreamingDeflate();
  // Tracks the last async compress+notify so stop() can await it.
  private pendingFlush: Promise<void> = Promise.resolve();

  constructor(
    private readonly eventManager: EventManager,
    private readonly config: Configuration,
    private readonly sessionManager: SessionManager
  ) {
    this.eventManager.registerHandler<RawReplayEvent>({
      canHandle: (event): event is RawReplayEvent =>
        event.kind === EventKind.RAW && 'format' in event && event.format === EventFormat.REPLAY,
      handle: monitor((event: RawReplayEvent) => {
        this.onRecord(event.data as BrowserRecord, event.view?.id);
      }),
    });

    this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: monitor((event: LifecycleEvent) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          this.flush('session_renew');
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          this.nextCreationReason = 'session_renew';
        }
      }),
    });
  }

  private isReplaySampled(sessionId: string): boolean {
    return isSessionSampled(
      sessionId,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.sessionReplaySampleRate)
    );
  }

  private onRecord(record: BrowserRecord, viewId: string | undefined): void {
    // Detect view change
    if (viewId && this.currentViewId && viewId !== this.currentViewId) {
      this.flush('view_change');
    }

    if (viewId) {
      this.currentViewId = viewId;
    }

    if (!this.segment) {
      const context = this.getSegmentContext();
      if (!context) {
        return;
      }

      const indexInView = this.getNextSegmentIndex(context.view.id);
      this.segment = new Segment(context, this.nextCreationReason, indexInView);
      this.nextCreationReason = 'init';
      this.scheduleFlush();
    }

    this.segment.addRecord(record);

    if (this.segment.estimatedSize > SEGMENT_BYTES_LIMIT) {
      this.flush('segment_bytes_limit');
    }
  }

  private getSegmentContext(): SegmentContext | undefined {
    const session = this.sessionManager.getSession();
    if (session.status !== 'active' || !this.currentViewId || !this.isReplaySampled(session.id)) {
      return undefined;
    }

    return {
      application: { id: this.config.applicationId },
      session: { id: session.id },
      view: { id: this.currentViewId },
    };
  }

  private getNextSegmentIndex(viewId: string): number {
    const current = this.segmentIndexPerView.get(viewId) ?? 0;
    this.segmentIndexPerView.set(viewId, current + 1);
    return current;
  }

  getViewReplayStats(viewId: string): ViewReplayStats | undefined {
    return this.viewReplayStats.get(viewId);
  }

  private flush(reason: CreationReason): void {
    this.clearFlushTimeout();

    if (this.segment && !this.segment.isEmpty) {
      const flushResult = this.segment.flush();
      const viewId = flushResult.metadata.view.id;
      const current = this.viewReplayStats.get(viewId) ?? { segments_count: 0, segments_total_raw_size: 0 };
      this.viewReplayStats.set(viewId, {
        segments_count: current.segments_count + 1,
        segments_total_raw_size: current.segments_total_raw_size + flushResult.rawBytesCount,
      });

      const data = Buffer.from(flushResult.serializedSegment, 'utf8');
      this.pendingFlush = this.deflate.compressSegment(data).then((compressed) => {
        this.eventManager.notify({
          kind: EventKind.SERVER,
          track: EventTrack.REPLAY,
          data: {
            metadata: flushResult.metadata,
            rawBytesCount: flushResult.rawBytesCount,
            compressed,
          },
        });
      });
    }

    this.segment = null;
    this.nextCreationReason = reason;

    // New session gets a fresh deflate context so its segments form an
    // independent ZLIB stream.
    if (reason === 'session_renew') {
      this.deflate = new StreamingDeflate();
    }
  }

  /**
   * Flush any pending segment and wait for compression to complete.
   * Call on graceful app shutdown (e.g. `app.on('before-quit')`) so the
   * final segment is queued for the transport layer before process exit.
   */
  stop(): Promise<void> {
    this.flush('segment_duration_limit');
    return this.pendingFlush;
  }

  private scheduleFlush(): void {
    this.clearFlushTimeout();
    this.flushTimeoutId = globalThis.setTimeout(() => {
      this.flush('segment_duration_limit');
    }, SEGMENT_DURATION_LIMIT);
  }

  private clearFlushTimeout(): void {
    if (this.flushTimeoutId !== null) {
      globalThis.clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }
}
