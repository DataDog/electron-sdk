/**
 * Channels the IPC instrumentation should never turn into a RUM event. `datadog:`-prefixed channels
 * are the SDK's own internal bridge channels (see `src/common/channels.ts`), excluded everywhere IPC
 * is patched (`src/instrument/ipc.ts`, `src/preload/ipc.ts`) so the SDK doesn't instrument itself.
 *
 * `get-internal-context` is hardcoded on top of that, specifically to keep the playground demo's RUM
 * data clean: it's the playground's own internal-context lookup (used to display the session id), not
 * one of the `ipc-demo:*` scenario channels, and firing on every load/refresh would clutter the demo
 * data. This is a demo-only special case, not a general SDK behavior — a real consuming app with its
 * own unrelated channel named `get-internal-context` would also have it silently excluded, which is
 * acceptable for this prototype but worth revisiting (e.g. an app-configurable exclusion list) before
 * this graduates past prototype status.
 */
const HARDCODED_EXCLUDED_CHANNELS = new Set(['get-internal-context']);

export function isExcludedIpcChannel(channel: string): boolean {
  return channel.startsWith('datadog:') || HARDCODED_EXCLUDED_CHANNELS.has(channel);
}
