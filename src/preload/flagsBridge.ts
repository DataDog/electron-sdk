import { contextBridge, ipcRenderer } from 'electron';
import {
  FLAGS_BRIDGE_ENABLED_CHANNEL,
  FLAGS_EVALUATIONS_CHANNEL,
  FLAGS_SNAPSHOT_CHANNEL,
  FLAGS_UPDATE_CHANNEL,
} from '../common';
import { FLAGS_BRIDGE_GLOBAL, type FlagsBridge } from '../common/flags/flagsBridge';

declare const window: Record<string, unknown>;

// Guard against double execution when the preload is registered more than once on the same
// session: `window` persists across executions of the same preload within a frame, so the flag
// survives where a module-level variable would not (B5).
const DD_FLAGS_BRIDGE_INIT = '__dd_flags_bridge_initialized';

/**
 * Preload bridge exposing the feature flags IPC surface to renderer pages (M4.5):
 * `window.DatadogFlagsBridge` with `getSnapshot`, `subscribe` and `sendEvaluations`,
 * beside `DatadogEventBridge`. Payloads cross IPC as JSON strings.
 *
 * - With `contextIsolation`, the bridge is exposed through `contextBridge`; without it,
 *   the preload shares the page's `window` and the bridge is set there directly.
 * - Runs once per frame, and keeps a single `ipcRenderer` listener for snapshot pushes.
 * - Not exposed at all when main answers that this session is excluded by
 *   `featureFlags.excludedPartitions` (P1). `DatadogEventBridge` is unaffected.
 */
export function registerFlagsBridge(): void {
  if (window[DD_FLAGS_BRIDGE_INIT]) {
    return;
  }
  window[DD_FLAGS_BRIDGE_INIT] = true;

  if (ipcRenderer.sendSync(FLAGS_BRIDGE_ENABLED_CHANNEL) === false) {
    return;
  }

  const updateListeners = new Set<(snapshot: string) => void>();
  ipcRenderer.on(FLAGS_UPDATE_CHANNEL, (_event: unknown, snapshot: unknown) => {
    if (typeof snapshot !== 'string') {
      return;
    }
    for (const listener of updateListeners) {
      listener(snapshot);
    }
  });

  const bridge = {
    getSnapshot: () => ipcRenderer.invoke(FLAGS_SNAPSHOT_CHANNEL) as Promise<string | undefined>,
    subscribe: (callback: (snapshot: string) => void): (() => void) => {
      updateListeners.add(callback);
      return () => {
        updateListeners.delete(callback);
      };
    },
    sendEvaluations: (json: string): void => {
      if (typeof json === 'string') {
        ipcRenderer.send(FLAGS_EVALUATIONS_CHANNEL, json);
      }
    },
  } satisfies FlagsBridge;

  if (process.contextIsolated) {
    contextBridge.exposeInMainWorld(FLAGS_BRIDGE_GLOBAL, bridge);
  } else {
    window[FLAGS_BRIDGE_GLOBAL] = bridge;
  }
}

registerFlagsBridge();
