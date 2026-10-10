import type { FlagsSnapshot } from './types';

/** A renderer frame, identified the way `webFrameMain.fromId` expects. */
export interface PendingFrame {
  processId: number;
  routingId: number;
}

/**
 * Process-global holder for the feature flags subsystem state, shared between
 * the instrument bundle (which registers IPC channels before init) and the init
 * module (which installs the real handlers). Uses Symbol.for so two module
 * instances (e.g. instrument + init from different bundles) observe the same
 * holder (D12/D13).
 */
export interface FlagsHolder {
  /** The handler installed by init; the thin instrument handler delegates to it. */
  flagsStateHandler?: (ipcEvent: Electron.IpcMainInvokeEvent) => unknown;
  /** Whether the datadog:flags-* channels have been registered in this process. */
  channelsRegistered?: boolean;
  /** Frames that asked for a snapshot before init, re-checked by init before their first push. */
  pendingSubscribers?: PendingFrame[];
  /**
   * Installed by init from `featureFlags.excludedPartitions`: whether a renderer's
   * session is excluded from feature flags (P1). Undefined before init.
   */
  isSenderExcluded?: (sender: Electron.WebContents | undefined) => boolean;
}

export const MAX_PENDING_SUBSCRIBERS = 1000;

const FLAGS_HOLDER = Symbol.for('@datadog/electron-sdk:flagsHolder');

export function getFlagsHolder(): FlagsHolder {
  const holder = (globalThis as Record<symbol, FlagsHolder>)[FLAGS_HOLDER];
  if (holder !== undefined) {
    return holder;
  }
  const created: FlagsHolder = {};
  (globalThis as Record<symbol, FlagsHolder>)[FLAGS_HOLDER] = created;
  return created;
}

/** Record a pre-init frame once; bounded, the oldest is dropped first. */
export function addPendingSubscriber(frame: PendingFrame): void {
  const holder = getFlagsHolder();
  const pending = (holder.pendingSubscribers ??= []);
  if (pending.some((entry) => entry.processId === frame.processId && entry.routingId === frame.routingId)) {
    return;
  }
  pending.push({ processId: frame.processId, routingId: frame.routingId });
  while (pending.length > MAX_PENDING_SUBSCRIBERS) {
    pending.shift();
  }
}

/** Remove and return every pending frame (init consumes them once). */
export function takePendingSubscribers(): PendingFrame[] {
  const holder = getFlagsHolder();
  const pending = holder.pendingSubscribers ?? [];
  holder.pendingSubscribers = [];
  return pending;
}

/** The minimal snapshot (D12): scalar fields and `tracking`, no configuration or context. */
export function minimalFlagsSnapshot(status: 'NOT_READY' | 'DISABLED'): FlagsSnapshot {
  return {
    revision: 0,
    status,
    contextRevision: 0,
    configurationRevision: 0,
    tracking: { exposures: false, rum: false, evaluations: false },
  };
}
