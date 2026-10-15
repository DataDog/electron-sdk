/**
 * The page-world bridge contract between the SDK preload (producer) and the renderer flags
 * provider (consumer), shared so the two cannot drift (A2). Payloads are JSON strings.
 */
export interface FlagsBridge {
  /** The current snapshot JSON, or `undefined` when main gives no answer. */
  getSnapshot: () => Promise<string | undefined>;
  /** Receive every snapshot JSON main pushes to this frame; returns an unsubscribe. */
  subscribe: (callback: (snapshot: string) => void) => () => void;
  /** Send one JSON-encoded evaluation batch to main. */
  sendEvaluations: (json: string) => void;
}

/** The page-world global the preload exposes the bridge on. */
export const FLAGS_BRIDGE_GLOBAL = 'DatadogFlagsBridge';
