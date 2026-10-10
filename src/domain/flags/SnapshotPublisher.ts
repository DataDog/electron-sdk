import { webContents as electronWebContents, webFrameMain } from 'electron';
import type { Subscription } from '@datadog/browser-core';
import { isAllowedRendererFrame } from '../../assembly';
import { getFlagsHolder, minimalFlagsSnapshot, takePendingSubscribers } from '../../common/flags/flagsHolder';
import type { PendingFrame } from '../../common/flags/flagsHolder';
import { FLAGS_UPDATE_CHANNEL } from '../../common';
import { monitor } from '../telemetry';
import type { FlagsSnapshot } from '../../common/flags/types';
import type { FlagsState } from './FlagsState';

interface TrackedWebContents {
  webContents: Electron.WebContents;
  frameKeys: Set<string>;
  detach: () => void;
}

/**
 * Publishes flags snapshots to renderer frames over IPC, gated by the init-time
 * `allowedRendererHosts` (D12). Snapshots carry the targeting context, so they follow
 * the same origin policy as the RUM bridge.
 *
 * - The instrument bundle registers a thin handler that answers a minimal NOT_READY
 *   snapshot before init and records the frame as a pending subscriber; {@link start}
 *   re-checks those frames and pushes the current snapshot to the allowed ones.
 * - After init, every snapshot response and every push is gated per frame by the
 *   init-time `allowedRendererHosts`.
 * - The publisher addresses the frame (`webFrameMain.fromId` + `frame.send`), not the
 *   whole webContents; it re-checks the frame's current origin and liveness before every
 *   send, and drops the subscription on `did-frame-navigate` for that frame, and every
 *   frame of a webContents on `render-process-gone` and `destroyed`. A navigated or
 *   reloaded document's preload re-subscribes and is checked again.
 */
export class SnapshotPublisher {
  private readonly subscribedFrames = new Map<string, PendingFrame & { webContentsId?: number }>();
  private readonly trackedWebContents = new Map<number, TrackedWebContents>();
  private stateSubscription: Subscription | undefined;

  constructor(
    private readonly state: FlagsState,
    private readonly allowedRendererHosts: string[],
    private readonly isSenderExcluded: (sender: Electron.WebContents | undefined) => boolean = () => false
  ) {}

  /**
   * Install the snapshot handler and the state subscription, then re-check the frames
   * that subscribed before init and push them the current snapshot. Call at init.
   */
  start(): void {
    getFlagsHolder().flagsStateHandler = (ipcEvent: Electron.IpcMainInvokeEvent): string | undefined => {
      const frame = ipcEvent.senderFrame;
      if (this.isSenderExcluded(ipcEvent.sender)) {
        // An excluded session gets no answer at all (P1).
        return undefined;
      }
      if (frame === null || frame === undefined || !this.isFrameAllowed(frame)) {
        return JSON.stringify(minimalFlagsSnapshot('DISABLED'));
      }
      this.subscribeFrame(frame, ipcEvent.sender);
      return JSON.stringify(publishedSnapshot(this.state.snapshot()));
    };
    this.stateSubscription = this.state.subscribe(() => {
      this.publishSnapshot();
    });
    this.checkPendingSubscribers(takePendingSubscribers());
  }

  /** Release the handler, the state subscription and every webContents listener. */
  stop(): void {
    const holder = getFlagsHolder();
    holder.flagsStateHandler = undefined;
    this.stateSubscription?.unsubscribe();
    this.stateSubscription = undefined;
    for (const tracked of this.trackedWebContents.values()) {
      tracked.detach();
    }
    this.trackedWebContents.clear();
    this.subscribedFrames.clear();
  }

  private checkPendingSubscribers(pendingFrames: PendingFrame[]): void {
    const json = JSON.stringify(publishedSnapshot(this.state.snapshot()));
    for (const pending of pendingFrames) {
      const frame = webFrameMain.fromId(pending.processId, pending.routingId);
      if (frame === undefined || frame === null || !this.isFrameAllowed(frame)) {
        continue;
      }
      const webContents = electronWebContents.fromFrame(frame);
      if (this.isSenderExcluded(webContents)) {
        continue;
      }
      this.subscribeFrame(frame, webContents);
      sendToFrame(frame, json);
    }
  }

  private isFrameAllowed(frame: { origin: string; url: string }): boolean {
    return isAllowedRendererFrame(frame, this.allowedRendererHosts);
  }

  private subscribeFrame(frame: PendingFrame, webContents: Electron.WebContents | undefined): void {
    const key = frameKey(frame.processId, frame.routingId);
    this.subscribedFrames.set(key, {
      processId: frame.processId,
      routingId: frame.routingId,
      ...(webContents !== undefined ? { webContentsId: webContents.id } : {}),
    });
    if (webContents !== undefined) {
      this.track(webContents).frameKeys.add(key);
    }
  }

  private track(webContents: Electron.WebContents): TrackedWebContents {
    const existing = this.trackedWebContents.get(webContents.id);
    if (existing !== undefined) {
      return existing;
    }
    const frameKeys = new Set<string>();
    const dropAll = monitor(() => {
      for (const key of frameKeys) {
        this.subscribedFrames.delete(key);
      }
      frameKeys.clear();
    });
    const onFrameNavigate = monitor(
      (
        _event: unknown,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        _isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
      ) => {
        const key = frameKey(frameProcessId, frameRoutingId);
        frameKeys.delete(key);
        this.subscribedFrames.delete(key);
      }
    );
    const onDestroyed = monitor(() => {
      dropAll();
      tracked.detach();
      this.trackedWebContents.delete(webContents.id);
    });
    webContents.on('did-frame-navigate', onFrameNavigate);
    webContents.on('render-process-gone', dropAll);
    webContents.once('destroyed', onDestroyed);
    const tracked: TrackedWebContents = {
      webContents,
      frameKeys,
      detach: () => {
        webContents.removeListener('did-frame-navigate', onFrameNavigate);
        webContents.removeListener('render-process-gone', dropAll);
        webContents.removeListener('destroyed', onDestroyed);
      },
    };
    this.trackedWebContents.set(webContents.id, tracked);
    return tracked;
  }

  private publishSnapshot(): void {
    const json = JSON.stringify(publishedSnapshot(this.state.snapshot()));
    for (const [key, subscribed] of this.subscribedFrames) {
      const frame = webFrameMain.fromId(subscribed.processId, subscribed.routingId);
      if (frame === undefined || frame === null || frame.isDestroyed() || !this.isFrameAllowed(frame)) {
        this.unsubscribe(key, subscribed.webContentsId);
        continue;
      }
      if (!sendToFrame(frame, json)) {
        this.unsubscribe(key, subscribed.webContentsId);
      }
    }
  }

  private unsubscribe(key: string, webContentsId: number | undefined): void {
    this.subscribedFrames.delete(key);
    if (webContentsId !== undefined) {
      this.trackedWebContents.get(webContentsId)?.frameKeys.delete(key);
    }
  }
}

/**
 * Answer `DISABLED` to every snapshot request when `featureFlags` is not configured, and
 * tell the frames that subscribed before init, so their providers stop waiting (B3).
 * The minimal snapshot carries no configuration or context, so no origin check applies.
 */
/**
 * The snapshot main publishes to renderers and spawned processes. While the state is
 * `NOT_READY` (before the first configuration is served) that is the minimal `NOT_READY`
 * snapshot, with no context: the wire contract only carries a context with a READY, STALE
 * or ERROR status, so the full NOT_READY snapshot would be rejected by every parser and
 * reported as an invalid snapshot.
 */
export function publishedSnapshot(snapshot: FlagsSnapshot): FlagsSnapshot {
  return snapshot.status === 'NOT_READY' ? minimalFlagsSnapshot('NOT_READY') : snapshot;
}

export function startDisabledFlagsResponder(): void {
  const json = JSON.stringify(minimalFlagsSnapshot('DISABLED'));
  getFlagsHolder().flagsStateHandler = () => json;
  for (const pending of takePendingSubscribers()) {
    const frame = webFrameMain.fromId(pending.processId, pending.routingId);
    if (frame !== undefined && frame !== null) {
      sendToFrame(frame, json);
    }
  }
}

/** Send to a frame; `false` when the frame was destroyed between the check and the send. */
function sendToFrame(frame: Electron.WebFrameMain, json: string): boolean {
  try {
    frame.send(FLAGS_UPDATE_CHANNEL, json);
    return true;
  } catch {
    return false;
  }
}

function frameKey(processId: number, routingId: number): string {
  return `${processId}:${routingId}`;
}
