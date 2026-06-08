import { ONE_SECOND, setTimeout, clearTimeout } from '@datadog/browser-core';
import { EventFormat, EventKind, EventTrack, LifecycleKind } from '../../event';
import type { EventManager, RawReplayEvent, LifecycleEvent } from '../../event';
import type { Configuration } from '../../config';
import type { SessionManager } from '../session';
import { monitor } from '../telemetry';
import { CreationReason, Segment, type BrowserRecord, type SegmentContext } from './Segment';
import { StreamingDeflate } from '../../tools/StreamingDeflate';

// Matches the browser SDK flush cadence.
const SEGMENT_DURATION_LIMIT = 5 * ONE_SECOND;

// 10 MB matches the iOS SDK (DatadogSessionReplay maxObjectSize). The browser
// SDK caps at 60 KB because of browser fetch/IPC body-size constraints that do
// not apply in the Electron main process.
const SEGMENT_BYTES_LIMIT = 10 * 1024 * 1024;

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
  private nextCreationReason: CreationReason = CreationReason.INIT;
  private segmentIndexPerView = new Map<string, number>();
  private viewReplayStats = new Map<string, ViewReplayStats>();
  private flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
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
        this.onRecord(event.data, event.view.id);
      }),
    });

    this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: monitor((event: LifecycleEvent) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          this.flush(CreationReason.INIT);
        } else if (event.lifecycle === LifecycleKind.SESSION_RENEW) {
          // Fresh deflate context so the new session's segments form an
          // independent ZLIB stream the backend can stitch separately.
          this.deflate = new StreamingDeflate();
          // All view data from the old session is obsolete — clear to prevent
          // unbounded growth across long-lived sessions.
          this.segmentIndexPerView.clear();
          this.viewReplayStats.clear();
        }
      }),
    });
  }

  private onRecord(record: BrowserRecord, viewId: string | undefined): void {
    // Detect view change
    if (viewId && this.currentViewId && viewId !== this.currentViewId) {
      this.flush(CreationReason.VIEW_CHANGE);
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
      this.nextCreationReason = CreationReason.INIT;
      this.scheduleFlush();
    }

    this.segment.addRecord(record);

    if (this.segment.estimatedSize > SEGMENT_BYTES_LIMIT) {
      this.flush(CreationReason.SEGMENT_BYTES_LIMIT);
    }
  }

  private getSegmentContext(): SegmentContext | undefined {
    const session = this.sessionManager.getSession();
    if (session.status !== 'active' || !this.currentViewId) {
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
      this.pendingFlush = this.deflate.compressSegment(data).then(
        monitor((compressed: Buffer) => {
          this.eventManager.notify({
            kind: EventKind.SERVER,
            track: EventTrack.REPLAY,
            data: {
              metadata: flushResult.metadata,
              rawBytesCount: flushResult.rawBytesCount,
              compressed,
            },
          });
        })
      );
    }

    this.segment = null;
    this.nextCreationReason = reason;
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
    this.flushTimeoutId = setTimeout(() => {
      this.flush(CreationReason.SEGMENT_DURATION_LIMIT);
    }, SEGMENT_DURATION_LIMIT);
  }

  private clearFlushTimeout(): void {
    if (this.flushTimeoutId !== null) {
      clearTimeout(this.flushTimeoutId);
      this.flushTimeoutId = null;
    }
  }
}
