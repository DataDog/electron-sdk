import { ErrorCode, type FlagValueType } from '@openfeature/web-sdk';
import { timeStampNow } from '@datadog/js-core/time';
import { display } from '../../tools/display';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import { EvaluationReporter } from '../../common/flags/EvaluationReporter';
import { buildEvaluationRecord } from '../../common/flags/evaluationRecord';
import { parseFlagsSnapshot } from '../../common/flags/flagsPayloads';
import {
  contextRequestMessage,
  evaluationsMessage,
  helloMessage,
  type ChildMessage,
} from '../../common/flags/childProtocol';
import type { FlagsSnapshot, FlagsStatus } from '../../common/flags/types';
import {
  createDisconnectedEndpoint,
  createFramesEndpoint,
  createPortEndpoint,
  type FlagsEndpoint,
  type FlagsPortLike,
} from './childEndpoints';

/** Milliseconds a context request waits for main's answer before resolving `accepted: false`. */
export const CONTEXT_REQUEST_TIMEOUT = 5000;
const DEFAULT_READY_TIMEOUT = 5000;

/** The result of one flag evaluation in a spawned process. */
export interface ChildFlagDetails<T> {
  flagKey: string;
  value: T;
  variant?: string;
  reason?: string;
  errorCode?: string;
  flagMetadata: Record<string, unknown>;
}

/** Main's answer to {@link ChildFlagsClient.requestContextUpdate}. */
export interface ContextUpdateResult {
  accepted: boolean;
  /** The context revision now in effect, when accepted. */
  contextRevision?: number;
}

/** The app-routed endpoint of a forked child: frames go out through `send`. */
export interface FlagsFramesSender {
  send: (frame: string) => void;
}

interface ChildTimers {
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

/** Plain-runtime timers; the flush timer is unref'd so it never keeps a child alive. */
/** The event {@link ChildFlagsClient.onChange} listeners receive. */
export interface FlagsChangeEvent {
  /** Revision of the snapshot now applied (a new rules configuration or a new context). */
  revision: number;
  /** Status after the snapshot was applied. */
  status: FlagsStatus;
}

const runtimeTimers: ChildTimers = {
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (id) => globalThis.clearTimeout(id as ReturnType<typeof globalThis.setTimeout>),
};

/**
 * Feature flags in a spawned process (a `child_process` fork, a `utilityProcess` or a
 * `worker_threads` worker). Main owns the configuration and the evaluation context and
 * pushes snapshots over the channel opened with `openFlagsChannel`; this client evaluates
 * locally and synchronously, and reports evaluations to main, which deduplicates exposures
 * and attributes them to the main process. Before the first snapshot every read returns the
 * caller's default with `PROVIDER_NOT_READY`.
 *
 * The client never listens on, refs or writes to a channel the app owns: it uses the port
 * the app handed over, or the frames the app routes through `receive`. Connection order does
 * not matter: main pushes the current snapshot when the channel opens, answers this client's
 * `hello`, and pushes every newer revision.
 *
 * @example
 * ```ts
 * import { connectFlags } from '@datadog/electron-sdk/child'
 * import { workerData } from 'node:worker_threads'
 *
 * const flags = connectFlags(workerData.flagsPort)
 * if (await flags.whenReady({ timeout: 3000 })) {
 *   const useNewIndexer = flags.getBooleanValue('new-indexer', false)
 * }
 * ```
 */
export class ChildFlagsClient {
  private readonly evaluator = new FlagsEvaluator();
  private readonly reporter: EvaluationReporter;
  private readonly statusListeners = new Set<(status: FlagsStatus) => void>();
  private readonly changeListeners = new Set<(event: FlagsChangeEvent) => void>();
  private readonly pendingContextRequests = new Map<
    number,
    { resolve: (result: ContextUpdateResult) => void; timer: unknown }
  >();
  private currentStatus: FlagsStatus = 'NOT_READY';
  private revision = -1;
  private contextRevision = 0;
  private configurationRevision = 0;
  private nextRequestId = 1;
  private closed = false;
  /** Settles of pending `whenReady` calls, so close and disconnect can settle them with false (R5). */
  private readonly readyWaiters = new Set<(ready: boolean) => void>();

  constructor(
    private readonly endpoint: FlagsEndpoint,
    private readonly timers: ChildTimers = runtimeTimers
  ) {
    this.reporter = new EvaluationReporter({
      send: (json) => this.endpoint.send(evaluationsMessage(json)),
      setTimeout: (callback, delay) => {
        const id = timers.setTimeout(callback, delay) as { unref?: () => void } | undefined;
        id?.unref?.();
        return id;
      },
      clearTimeout: (id) => timers.clearTimeout(id),
      // Child evaluations are correlated with the main view in main (D19).
      rumViaMain: true,
    });
    this.guard(() => {
      endpoint.setHandler(
        (message) => this.guard(() => this.onMessage(message)),
        () => this.guard(() => this.onEndpointClosed())
      );
      endpoint.send(helloMessage());
    });
  }

  /** The status of the latest snapshot: `NOT_READY` until main answers. */
  get status(): FlagsStatus {
    return this.currentStatus;
  }

  getBooleanValue(flagKey: string, defaultValue: boolean): boolean {
    return this.getBooleanDetails(flagKey, defaultValue).value;
  }

  getStringValue(flagKey: string, defaultValue: string): string {
    return this.getStringDetails(flagKey, defaultValue).value;
  }

  getNumberValue(flagKey: string, defaultValue: number): number {
    return this.getNumberDetails(flagKey, defaultValue).value;
  }

  getObjectValue<T>(flagKey: string, defaultValue: T): T {
    return this.getObjectDetails(flagKey, defaultValue).value;
  }

  getBooleanDetails(flagKey: string, defaultValue: boolean): ChildFlagDetails<boolean> {
    return this.evaluate('boolean', flagKey, defaultValue);
  }

  getStringDetails(flagKey: string, defaultValue: string): ChildFlagDetails<string> {
    return this.evaluate('string', flagKey, defaultValue);
  }

  getNumberDetails(flagKey: string, defaultValue: number): ChildFlagDetails<number> {
    return this.evaluate('number', flagKey, defaultValue);
  }

  getObjectDetails<T>(flagKey: string, defaultValue: T): ChildFlagDetails<T> {
    return this.evaluate('object', flagKey, defaultValue);
  }

  /**
   * Call `listener` whenever the flags may have changed: when an applied snapshot carries a new
   * rules configuration or a new context (even while the status stays READY), and on every
   * status change, like OpenFeature's `ConfigurationChanged`. A snapshot that changes neither
   * (e.g. only the tracking toggles) does not notify. Re-read the
   * flags you cache in the listener. A throwing listener is reported to main and never stops
   * the others. Listeners are dropped on `close()` and when the channel disconnects. Returns
   * an unsubscribe function.
   *
   * @example
   * ```ts
   * let useNewIndexer = flags.getBooleanValue('new-indexer', false)
   * const unsubscribe = flags.onChange(() => {
   *   useNewIndexer = flags.getBooleanValue('new-indexer', false)
   * })
   * ```
   */
  onChange(listener: (event: FlagsChangeEvent) => void): () => void {
    if (this.closed || !this.endpoint.connected) {
      return () => undefined;
    }
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  /** Call `listener` on every status change. Returns an unsubscribe function. */
  onStatusChange(listener: (status: FlagsStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => {
      this.statusListeners.delete(listener);
    };
  }

  /**
   * Resolve `true` once a READY or STALE snapshot is applied, `false` on timeout, when
   * flags are disabled, or when the client is closed or disconnected. Never rejects.
   */
  whenReady(options: { timeout?: number } = {}): Promise<boolean> {
    // Closed first: a closed client serves defaults even if its last snapshot was READY.
    if (this.closed || !this.endpoint.connected) {
      return Promise.resolve(false);
    }
    if (isServing(this.currentStatus)) {
      return Promise.resolve(true);
    }
    if (this.currentStatus === 'DISABLED') {
      return Promise.resolve(false);
    }
    return new Promise<boolean>((resolve) => {
      const settle = (ready: boolean) => {
        this.timers.clearTimeout(timer);
        unsubscribe();
        this.readyWaiters.delete(settle);
        resolve(ready);
      };
      this.readyWaiters.add(settle);
      const unsubscribe = this.onStatusChange((status) => {
        if (isServing(status)) settle(true);
        else if (status === 'DISABLED') settle(false);
      });
      const timer = this.timers.setTimeout(() => settle(false), options.timeout ?? DEFAULT_READY_TIMEOUT);
    });
  }

  /**
   * Ask main to replace the evaluation context. Main normalizes and may filter the request;
   * the promise resolves with its answer (`accepted: false` when rejected, after
   * {@link CONTEXT_REQUEST_TIMEOUT}, or before main's SDK is initialized). Reads keep the
   * current context until main pushes the new snapshot.
   */
  requestContextUpdate(context: Record<string, unknown>): Promise<ContextUpdateResult> {
    if (this.closed || !this.endpoint.connected) {
      return Promise.resolve({ accepted: false });
    }
    let payload: string;
    try {
      payload = JSON.stringify(context);
    } catch {
      return Promise.resolve({ accepted: false });
    }
    const id = this.nextRequestId++;
    return new Promise<ContextUpdateResult>((resolve) => {
      const timer = this.timers.setTimeout(() => {
        this.pendingContextRequests.delete(id);
        resolve({ accepted: false });
      }, CONTEXT_REQUEST_TIMEOUT);
      this.pendingContextRequests.set(id, { resolve, timer });
      this.endpoint.send(contextRequestMessage(id, payload));
    });
  }

  /** Flush pending records, release the endpoint and clear every timer. */
  close(): void {
    if (this.closed) return;
    this.guard(() => this.reporter.close());
    this.closed = true;
    this.endpoint.close();
    this.evaluator.stop();
    this.settleReadyWaiters();
    this.statusListeners.clear();
    this.changeListeners.clear();
    for (const [id, pending] of this.pendingContextRequests) {
      this.timers.clearTimeout(pending.timer);
      this.pendingContextRequests.delete(id);
      pending.resolve({ accepted: false });
    }
  }

  private evaluate<T>(type: FlagValueType, flagKey: string, defaultValue: T): ChildFlagDetails<T> {
    let details: ChildFlagDetails<T>;
    let contextRevision: number;
    try {
      const resolved = this.evaluator.resolve(type, flagKey, defaultValue);
      contextRevision = this.evaluator.contextRevision ?? this.contextRevision;
      details = {
        flagKey,
        value: resolved.value as T,
        ...(resolved.variant !== undefined ? { variant: resolved.variant } : {}),
        ...(resolved.reason !== undefined ? { reason: resolved.reason } : {}),
        ...(resolved.errorCode !== undefined ? { errorCode: resolved.errorCode } : {}),
        flagMetadata: { ...resolved.flagMetadata },
      };
    } catch (error) {
      this.reporter.reportError(error);
      return { flagKey, value: defaultValue, reason: 'ERROR', errorCode: ErrorCode.GENERAL, flagMetadata: {} };
    }
    if (!this.closed) {
      this.guard(() => this.reporter.add(buildEvaluationRecord(flagKey, details, contextRevision, timeStampNow())));
    }
    return details;
  }

  private onMessage(message: ChildMessage): void {
    if (this.closed) return;
    if (message.type === 'snapshot') {
      const snapshot = parseFlagsSnapshot(message.payload);
      if (snapshot === undefined) {
        throw new Error('invalid feature flags snapshot');
      }
      this.applySnapshot(snapshot);
    } else if (message.type === 'context-response') {
      const pending = this.pendingContextRequests.get(message.id);
      if (pending !== undefined) {
        this.pendingContextRequests.delete(message.id);
        this.timers.clearTimeout(pending.timer);
        pending.resolve(
          message.accepted && message.contextRevision !== undefined
            ? { accepted: true, contextRevision: message.contextRevision }
            : { accepted: message.accepted }
        );
      }
    }
  }

  private applySnapshot(snapshot: FlagsSnapshot): void {
    // Minimal snapshots (pre-init NOT_READY, DISABLED) carry revision 0 and never override a
    // real snapshot; real snapshots apply only when newer (D18).
    if (snapshot.revision === 0 ? this.revision > 0 : snapshot.revision <= this.revision) {
      return;
    }
    const previousStatus = this.currentStatus;
    const previousContextRevision = this.contextRevision;
    const previousConfigurationRevision = this.configurationRevision;
    this.revision = snapshot.revision;
    this.contextRevision = snapshot.contextRevision;
    this.configurationRevision = snapshot.configurationRevision;
    this.reporter.setTracking(snapshot.tracking);
    if (snapshot.configuration !== undefined || snapshot.status === 'ERROR') {
      this.evaluator.apply(snapshot);
    }
    if (snapshot.status !== this.currentStatus) {
      this.currentStatus = snapshot.status;
      for (const listener of [...this.statusListeners]) {
        this.guard(() => listener(snapshot.status));
      }
    }
    // Quiet (A5): only a new rules configuration, a new context or a status change can change
    // what the flags evaluate to; a tracking-only snapshot does not notify.
    if (
      snapshot.configurationRevision !== previousConfigurationRevision ||
      snapshot.contextRevision !== previousContextRevision ||
      snapshot.status !== previousStatus
    ) {
      const event: FlagsChangeEvent = { revision: snapshot.revision, status: snapshot.status };
      for (const listener of [...this.changeListeners]) {
        this.guard(() => listener(event));
      }
    }
  }

  private settleReadyWaiters(): void {
    for (const settle of [...this.readyWaiters]) {
      settle(false);
    }
  }

  private onEndpointClosed(): void {
    this.settleReadyWaiters();
    this.changeListeners.clear();
    for (const [id, pending] of this.pendingContextRequests) {
      this.timers.clearTimeout(pending.timer);
      this.pendingContextRequests.delete(id);
      pending.resolve({ accepted: false });
    }
  }

  /** Run SDK code; an invariant throw is reported to main and never reaches the app. */
  private guard(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reporter.reportError(error);
    }
  }
}

let warnedDisconnected = false;

/**
 * Connect a spawned process to main's feature flags.
 *
 * - **worker_threads / utilityProcess**: pass the port main handed over (`workerData`, or
 *   `event.ports[0]` of the app's first `process.parentPort` message).
 * - **child_process.fork**: pass `{ send }`, which writes frames into the app's own
 *   message protocol, and route incoming frames to `receive`.
 * - **standalone / tests**: `undefined` returns application defaults (one warning).
 *
 * Connection order does not matter: main's channel pushes the current snapshot when it opens,
 * answers this client's `hello`, and pushes every newer revision. Use `whenReady` for the
 * first configuration and `onChange` to re-read flags when the rules or the context change.
 *
 * @example
 * ```ts
 * import { connectFlags } from '@datadog/electron-sdk/child'
 *
 * const flags = connectFlags({ send: (frame) => process.send?.({ type: 'dd-flags', frame }) })
 * process.on('message', (msg) => (msg.type === 'dd-flags' ? flags.receive(msg.frame) : handleRequest(msg)))
 * const theme = flags.getStringValue('theme', 'light')
 * ```
 */
export function connectFlags(endpoint: FlagsFramesSender): ChildFlagsClient & { receive(frame: unknown): void };
export function connectFlags(endpoint: FlagsPortLike | undefined): ChildFlagsClient;
export function connectFlags(
  endpoint: FlagsPortLike | FlagsFramesSender | undefined
): ChildFlagsClient | (ChildFlagsClient & { receive(frame: unknown): void }) {
  if (endpoint === undefined || endpoint === null) {
    if (!warnedDisconnected) {
      warnedDisconnected = true;
      display.warn(
        'connectFlags() was called without a channel: feature flags return the application defaults. ' +
          'Pass the port or frames sender opened in main with openFlagsChannel().'
      );
    }
    return new ChildFlagsClient(createDisconnectedEndpoint());
  }
  if (typeof (endpoint as FlagsPortLike).postMessage === 'function') {
    return new ChildFlagsClient(createPortEndpoint(endpoint as FlagsPortLike, 'child'));
  }
  const frames = createFramesEndpoint((endpoint as FlagsFramesSender).send, 'child');
  const client = new ChildFlagsClient(frames) as ChildFlagsClient & { receive(frame: unknown): void };
  client.receive = (frame: unknown) => frames.receive(frame);
  return client;
}

function isServing(status: FlagsStatus): boolean {
  return status === 'READY' || status === 'STALE';
}
