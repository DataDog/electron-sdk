import { monitor } from '../domain/telemetry';
import type { IpcMainEvent } from 'electron';

/**
 * Controls which IPC messages from the renderer are passed to the pipeline.
 *
 * Tracks frames whose origin was verified while senderFrame was alive, keyed by
 * "${processId}:${frameId}". Allows terminal IPC messages (e.g. profiling flush on
 * page unload) to be accepted after senderFrame goes null due to frame destruction.
 */
export class RendererIpcGate {
  // Tracks frames whose origin was verified while senderFrame was alive.
  private readonly allowedFrames = new Set<string>();
  // Per-frame cleanup functions (evict a frame from allowedFrames). Called by the navigate/destroyed
  // handlers, and also lazily when the IPC handler detects a disallowed origin on a slot that was
  // previously allowed (evict-on-reuse for silent iframe removals).
  //
  // Note: Electron 39–41 does not expose a render-frame-deleted event on app or any synchronous
  // "subframe removed" event on WebContents, so proactive per-frame cleanup is not possible.
  // The lazy path handles the security risk; any unreachable stale entries are released when
  // the window is destroyed.
  private readonly frameCleanups = new Map<string, () => void>();
  // Shared lifecycle listeners per WebContents: avoids one listener pair per frame and prevents
  // MaxListenersExceededWarning when many subframes share the same WebContents.
  private readonly webContentsRegistry = new Map<
    IpcMainEvent['sender'],
    { frameKeys: Set<string>; removeListeners: () => void }
  >();

  constructor(private readonly allowedRendererHosts: string[]) {}

  /**
   * Returns true if the IPC event should be passed to the pipeline.
   * As a side effect, registers the frame in the allow-list on the first allowed senderFrame-present message.
   */
  isAllowed(ipcEvent: IpcMainEvent): boolean {
    const frameKey = `${ipcEvent.processId}:${ipcEvent.frameId}`;

    if (ipcEvent.senderFrame != null) {
      if (!isAllowedOrigin(ipcEvent.senderFrame.origin, ipcEvent.senderFrame.url, this.allowedRendererHosts)) {
        // Disallowed origin. If a stale key exists for this slot (from a previously allowed subframe
        // that was silently removed), evict it so a follow-up null-senderFrame IPC can't bypass filtering.
        if (this.allowedFrames.has(frameKey)) {
          this.frameCleanups.get(frameKey)?.();
        }
        return false;
      }
      // Allowed origin — register (or re-register; registerAllowedFrame is idempotent for the same sender).
      this.registerAllowedFrame(frameKey, ipcEvent.sender);
      return true;
    }

    // senderFrame is null (or missing): the frame navigated or was destroyed after sending.
    // Allow only if this frame was previously verified by the same WebContents sender.
    //
    // Multiple teardown IPCs are supported: the key persists until did-frame-navigate or
    // the WebContents 'destroyed' event evicts it, so a profile flush followed by a final
    // RUM view update both arrive here and are accepted.
    //
    // Stale-key note: a silently-removed subframe (no navigation) leaves its key until the
    // WebContents is destroyed. Exploiting this would require a new disallowed frame in the
    // same routing slot to send an IPC that arrives with senderFrame === null, which in turn
    // requires its destruction notification to precede its IPC on Chromium's ordered Mojo pipe.
    // Electron made this IPC channel frame-associated specifically to prevent this class of
    // race (electron/electron#32734, "Make ElectronBrowser mojo interface frame associated"),
    // but there is no documented guarantee for the cross-slot case (old frame's teardown vs. a
    // new frame reusing its routing ID): those travel through two distinct per-frame Mojo
    // receivers, so ordering rests on UI-thread task serialization rather than a stated rule.
    // The sender ownership check below is defense-in-depth against cross-WebContents slot
    // collisions, though it does not cover the same-WebContents subframe-reuse variant, which
    // still relies on the architectural argument above.
    if (!this.allowedFrames.has(frameKey)) return false;
    // Verify the message came from the WebContents that registered this key. A stale key from a
    // silently-removed frame could otherwise be claimed by any null-senderFrame IPC on that slot.
    if (!this.webContentsRegistry.get(ipcEvent.sender)?.frameKeys.has(frameKey)) return false;
    return true;
  }

  /**
   * Adds a frame to the allow-list and ensures shared lifecycle listeners are installed on the
   * WebContents. Multiple frames on the same WebContents share a single listener pair, preventing
   * listener accumulation when many subframes are registered.
   */
  private registerAllowedFrame(frameKey: string, sender: IpcMainEvent['sender']): void {
    this.allowedFrames.add(frameKey);

    // If this key was previously registered to a different sender (silent slot reuse after iframe
    // removal), remove it from the old sender to prevent the old WebContents' destruction from
    // deleting a key that now belongs to the new frame.
    for (const [existingSender, existingEntry] of this.webContentsRegistry) {
      if (existingSender !== sender && existingEntry.frameKeys.has(frameKey)) {
        existingEntry.frameKeys.delete(frameKey);
        if (existingEntry.frameKeys.size === 0) existingEntry.removeListeners();
        break;
      }
    }

    if (!this.webContentsRegistry.has(sender)) {
      // Install one shared listener pair for this WebContents.
      const onFrameNavigate = (
        _event: unknown,
        _url: string,
        _httpResponseCode: number,
        _httpStatusText: string,
        _isMainFrame: boolean,
        frameProcessId: number,
        frameRoutingId: number
      ) => {
        const navigatedKey = `${frameProcessId}:${frameRoutingId}`;
        // Guard: only evict if this sender owns the key. Two WebContents can share a renderer
        // process (Electron's process pool), so a navigation on W1 must not evict W2's key.
        const entry = this.webContentsRegistry.get(sender);
        if (entry?.frameKeys.has(navigatedKey)) {
          this.evictFrame(navigatedKey, sender);
        }
      };
      const onDestroyed = () => {
        const entry = this.webContentsRegistry.get(sender);
        if (!entry) return;
        for (const key of entry.frameKeys) {
          this.allowedFrames.delete(key);
          this.frameCleanups.delete(key);
        }
        removeListeners();
      };
      // Wrap after defining handlers; closures capture the binding, not the value.
      const monitoredNavigate = monitor(onFrameNavigate);
      const monitoredDestroyed = monitor(onDestroyed);

      const removeListeners = () => {
        sender.off('did-frame-navigate', monitoredNavigate);
        sender.off('destroyed', monitoredDestroyed);
        this.webContentsRegistry.delete(sender);
      };

      this.webContentsRegistry.set(sender, { frameKeys: new Set(), removeListeners });
      sender.on('did-frame-navigate', monitoredNavigate);
      sender.once('destroyed', monitoredDestroyed);
    }

    this.webContentsRegistry.get(sender)!.frameKeys.add(frameKey);
    this.frameCleanups.set(frameKey, () => this.evictFrame(frameKey, sender));
  }

  /**
   * Removes a single frame from the allow-list and from its WebContents registry entry.
   * When the last frame for a WebContents is evicted, the shared listeners are also removed.
   */
  private evictFrame(frameKey: string, sender: IpcMainEvent['sender']): void {
    this.allowedFrames.delete(frameKey);
    this.frameCleanups.delete(frameKey);

    const entry = this.webContentsRegistry.get(sender);
    if (entry) {
      entry.frameKeys.delete(frameKey);
      if (entry.frameKeys.size === 0) {
        entry.removeListeners();
      }
    }
  }
}

/**
 * Mirrors the Browser SDK's matchesHostEntry logic so both layers enforce the same rules.
 * Supports exact match, subdomain suffix (e.g. 'example.com' matches 'sub.example.com'),
 * and single-wildcard glob patterns (e.g. 'preview-*.example.com').
 */
function matchesRendererHostEntry(host: string, entry: string): boolean {
  if (!entry.includes('*')) return host === entry || (entry.includes('.') && host.endsWith(`.${entry}`));
  const parts = entry.split('*');
  if (parts.length !== 2) return false;
  const [prefix, suffix] = parts;
  return host.length > prefix.length + suffix.length && host.startsWith(prefix) && host.endsWith(suffix);
}

function isAllowedOrigin(origin: string | undefined, url: string | undefined, allowedRendererHosts: string[]): boolean {
  // Require at least one piece of frame context so we can identify the sender; reject when both are
  // absent (e.g. a senderFrame with no properties, which should never happen in real Electron).
  if (origin === undefined && url === undefined) return false;
  // Wildcard: allow every renderer that has a live senderFrame, regardless of origin/scheme.
  if (allowedRendererHosts.includes('*')) return true;
  // Electron reports 'null' (the string) for non-standard custom protocols. Fall back to the frame
  // URL in that case, which is set by the main process and safe to use for host matching.
  const resolved = resolveOrigin(origin, url);
  if (!resolved) return false;
  // file:// origin has no hostname; normalize to '' to match the stored value
  if (resolved === 'file://') return allowedRendererHosts.includes('');
  try {
    const hostname = new URL(resolved).hostname;
    return allowedRendererHosts.some((entry) => entry !== '' && matchesRendererHostEntry(hostname, entry));
  } catch {
    return false;
  }
}

function resolveOrigin(origin: string | undefined, url: string | undefined): string | undefined {
  if (origin && origin !== 'null') return origin;
  if (!url) return undefined;
  try {
    const { protocol, hostname } = new URL(url);
    if (protocol === 'file:') return 'file://';
    if (hostname) return `${protocol}//${hostname}`;
  } catch {
    /* empty */
  }
  return undefined;
}
