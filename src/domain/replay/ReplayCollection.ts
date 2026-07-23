import { ONE_SECOND, type TimeStamp } from '@datadog/js-core/time';
import { EventFormat, EventKind, EventTrack, LifecycleKind } from '../../event';
import type { EventManager, RawReplayEvent, LifecycleEvent } from '../../event';
import type { Configuration } from '../../config';
import type { FormatHooks } from '../../assembly';
import { correctedChildSampleRate, isSessionSampled } from '../../tools/Sampler';
import { StreamingDeflate } from '../../tools/StreamingDeflate';
import type { SessionManager } from '../session';
import { addError, clearTimeout, monitor, setTimeout } from '../telemetry';
import { registerReplayContext } from './replayContext';
import { byteSizeOf, CreationReason, Segment, type BrowserRecord, type SegmentContext } from './Segment';

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
 * - Estimated byte size limit (10MB) is exceeded
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
    private readonly sessionManager: SessionManager,
    hooks: FormatHooks
  ) {
    // Enrich renderer view events with this session's replay stats. Registered here (rather than by the
    // caller) so all replay-specific assembly logic lives with the collection, mirroring ProfilingCollection.
    registerReplayContext(
      hooks,
      (viewId) => this.getViewReplayStats(viewId),
      (at) => this.isReplayActiveAt(at)
    );

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

  private isReplaySampled(sessionId: string): boolean {
    return isSessionSampled(
      sessionId,
      correctedChildSampleRate(this.config.sessionSampleRate, this.config.sessionReplaySampleRate)
    );
  }

  /**
   * Whether replay is being recorded for the session that covered `at` — the sampling decision for
   * the event's *own* session, resolved by time (mirroring the session and profiling hooks), not the
   * current session. Keeps a late-delivered view event's has_replay consistent with its session
   * across an expiry/renewal boundary. Returns false when no tracked session covered `at`.
   */
  private isReplayActiveAt(at: TimeStamp): boolean {
    const sessionId = this.sessionManager.getTrackedSessionId(at);
    return sessionId !== undefined && this.isReplaySampled(sessionId);
  }

  private onRecord(record: BrowserRecord, viewId: string | undefined): void {
    // Session-boundary handling: replay compresses a session's segments into one persistent deflate
    // stream (reset on renewal), so a record must be compressed under the same session it belongs to.
    // When IPC is delayed across an inactivity expiry/renewal, the session active at processing time
    // may differ from the one that covered the record's capture time. We can't safely retro-attribute
    // it here — its bytes would still land in the current session's deflate stream, corrupting the
    // stitched replay — so we drop it (and report telemetry) rather than misattribute it into the
    // wrong session or view. This is correct and sufficient: the only cost is losing the occasional
    // straggler record at a boundary, and the telemetry lets us monitor how often that actually
    // happens. If it ever proves frequent enough to matter, a fuller fix — attributing the record to
    // its own session by resolving getTrackedSessionId(record.timestamp) in getSegmentContext (as
    // ProfilingCollection does), with per-session deflate handling — can follow.
    //
    // Only a genuine *mismatch* is reported: when both resolve to undefined (session not sampled /
    // not tracked) the record falls through to the normal silent drop in getSegmentContext, so we
    // don't emit telemetry for every record of an unsampled session.
    const owningSessionId = this.sessionManager.getTrackedSessionId(record.timestamp as TimeStamp);
    if (owningSessionId !== this.sessionManager.getTrackedSessionId()) {
      addError(new Error('Dropping replay record captured outside the current session'));
      return;
    }

    // Detect view change
    if (viewId && this.currentViewId && viewId !== this.currentViewId) {
      this.flush(CreationReason.VIEW_CHANGE);
    }

    if (viewId) {
      this.currentViewId = viewId;
    }

    let segment = this.ensureSegment();
    if (!segment) {
      return;
    }

    // Split *before* appending so the segment written to disk never exceeds the cap by a whole
    // record (a full snapshot can be large). A single record bigger than the cap is unavoidable —
    // it still gets its own segment. Flushing here starts a fresh segment for this record.
    const recordByteSize = byteSizeOf(record);
    if (!segment.isEmpty && segment.estimatedSize + recordByteSize > SEGMENT_BYTES_LIMIT) {
      this.flush(CreationReason.SEGMENT_BYTES_LIMIT);
      segment = this.ensureSegment();
      if (!segment) {
        return;
      }
    }

    segment.addRecord(record, recordByteSize);
  }

  /** Returns the current segment, creating one if needed. Null when there is no valid context. */
  private ensureSegment(): Segment | null {
    if (this.segment) {
      return this.segment;
    }

    const context = this.getSegmentContext();
    if (!context) {
      return null;
    }

    const indexInView = this.getNextSegmentIndex(context.view.id);
    this.segment = new Segment(context, this.nextCreationReason, indexInView);
    this.nextCreationReason = CreationReason.INIT;
    this.scheduleFlush();
    return this.segment;
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
      const segmentFlush = this.deflate.compressSegment(data).then(
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
      // Chain rather than replace so stop() awaits all in-flight compressions.
      // Without this, a SESSION_EXPIRED flush followed by a new-session flush
      // before the first compression completes would overwrite pendingFlush,
      // causing stop() to miss the expired session's last segment on quit.
      this.pendingFlush = Promise.all([this.pendingFlush, segmentFlush]).then(() => undefined);
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
    this.flush(CreationReason.SEGMENT_DURATION_LIMIT);
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
