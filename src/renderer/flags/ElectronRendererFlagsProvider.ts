import { OpenFeatureEventEmitter, ProviderEvents, ProviderNotReadyError } from '@openfeature/web-sdk';
import type {
  EvaluationContext,
  EvaluationDetails,
  FlagValue,
  FlagValueType,
  Hook,
  HookContext,
  JsonValue,
  ResolutionDetails,
} from '@openfeature/web-sdk';
import { timeStampNow } from '@datadog/js-core/time';
import { display } from '../../tools/display';
import { parseFlagsSnapshot, MAX_BATCH_ERROR_MESSAGE_LENGTH } from '../../common/flags/flagsPayloads';
import { FLAGS_BRIDGE_GLOBAL, type FlagsBridge } from '../../common/flags/flagsBridge';
import { buildEvaluationRecord, ResolutionLedger } from '../../common/flags/evaluationRecord';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import type { EvaluationBatch, EvaluationRecord, FlagsSnapshot, FlagsTracking } from '../../common/flags/types';

export const DEFAULT_INIT_TIMEOUT = 5_000;
export const FLUSH_INTERVAL = 1_000;
export const FLUSH_THRESHOLD = 50;
export const MAX_RECORDS_PER_BATCH = 100;
export const MAX_BATCH_BYTES = 64 * 1024;
export const MAX_ERRORS_PER_BATCH = 5;
const MAX_VIEW_URL_LENGTH = 2048;
const MAX_PREDEDUPE_KEYS = 1000;

/** The page-world globals this provider reads; declared locally because `src` has no DOM lib. */
interface PageWorld {
  [FLAGS_BRIDGE_GLOBAL]?: FlagsBridge;
  DD_RUM?: {
    addFeatureFlagEvaluation?: (key: string, value: unknown) => void;
    getInternalContext?: () => { view?: { id?: string; url?: string } } | undefined;
  };
  location?: { href?: string };
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (id: unknown) => void;
}

const pageWorld = globalThis as unknown as PageWorld;

export interface ElectronRendererFlagsProviderOptions {
  /** Milliseconds `initialize()` waits for a READY or STALE snapshot before rejecting. Defaults to 5000. */
  initTimeout?: number;
}

/**
 * The renderer-process OpenFeature provider for Datadog feature flags.
 *
 * It finds the `DatadogFlagsBridge` exposed by the SDK preload, receives the snapshots
 * main publishes and evaluates locally and synchronously. The context is owned by main:
 * `OpenFeature.setContext` in a renderer is ignored with a warning. Readiness follows the
 * snapshot status (`READY` or `STALE`); `initialize()` rejects with
 * `PROVIDER_NOT_READY` after `initTimeout`, and a later READY snapshot emits `Ready`.
 *
 * Evaluations are reported to main in bounded batches (exposures and metrics, deduped by
 * main) and, when RUM tracking is on, to the page's `DD_RUM.addFeatureFlagEvaluation`.
 * Without the bridge (preload not injected, or not Electron) the provider returns the
 * application defaults and never throws.
 *
 * @example
 * ```ts
 * import { OpenFeature } from '@openfeature/web-sdk'
 * import { ElectronRendererFlagsProvider } from '@datadog/electron-sdk/renderer'
 *
 * await OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider({ initTimeout: 3000 }))
 * const showBanner = OpenFeature.getClient().getBooleanValue('show-banner', false)
 * ```
 */
export class ElectronRendererFlagsProvider {
  readonly metadata = { name: 'ElectronRendererFlags' };
  readonly runsOn = 'client' as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly hooks: Hook[] = [this.buildTrackingHook()];

  private readonly initTimeout: number;
  private readonly bridge: FlagsBridge | undefined;
  private readonly evaluator = new FlagsEvaluator();
  private readonly ledger = new ResolutionLedger();
  private unsubscribe: (() => void) | undefined;
  private revision = -1;
  private snapshotStatus: FlagsSnapshot['status'] | undefined;
  private contextRevision = 0;
  private configurationRevision = 0;
  private evaluatable = false;
  private tracking: FlagsTracking = { exposures: false, rum: false, evaluations: false };
  private readonly readyWaiters = new Set<{ resolve: () => void; reject: (error: Error) => void }>();
  private records: EvaluationRecord[] = [];
  private errors: { message: string; stack?: string }[] = [];
  private readonly preDedupeKeys = new Set<string>();
  private flushTimer: unknown;
  private warnedContextChange = false;
  private closed = false;

  constructor(options: ElectronRendererFlagsProviderOptions = {}) {
    this.initTimeout = options.initTimeout ?? DEFAULT_INIT_TIMEOUT;
    this.bridge = pageWorld[FLAGS_BRIDGE_GLOBAL];
    if (this.bridge === undefined) {
      display.warn(
        'DatadogFlagsBridge is not available: feature flags return the application defaults. ' +
          'Check that the Datadog SDK is initialized with featureFlags and its preload is injected.'
      );
      return;
    }
    this.guard(() => {
      this.unsubscribe = this.bridge!.subscribe((json) => this.guard(() => this.onSnapshotJson(json)));
      this.bridge!.getSnapshot().then(
        (json) => this.guard(() => this.onSnapshotJson(json)),
        (error: unknown) => this.reportError(error)
      );
    });
  }

  initialize(_context: EvaluationContext = {}): Promise<void> {
    if (this.evaluatable) {
      return Promise.resolve();
    }
    if (this.bridge === undefined) {
      return Promise.reject(new ProviderNotReadyError('DatadogFlagsBridge is not available'));
    }
    if (this.snapshotStatus === 'DISABLED') {
      return Promise.reject(new ProviderNotReadyError('feature flags are disabled'));
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        resolve: () => {
          pageWorld.clearTimeout(timeoutId);
          this.readyWaiters.delete(waiter);
          resolve();
        },
        reject: (error: Error) => {
          pageWorld.clearTimeout(timeoutId);
          this.readyWaiters.delete(waiter);
          reject(error);
        },
      };
      const timeoutId = pageWorld.setTimeout(() => {
        waiter.reject(new ProviderNotReadyError('no feature flags snapshot was ready before initTimeout'));
      }, this.initTimeout);
      this.readyWaiters.add(waiter);
    });
  }

  /** The context is owned by main (D2): a renderer context change is ignored. */
  onContextChange(_oldContext: EvaluationContext | undefined, _newContext: EvaluationContext): Promise<void> {
    if (!this.warnedContextChange) {
      this.warnedContextChange = true;
      display.warn(
        'The feature flags context is set in the main process (ElectronMainFlagsProvider); renderer context changes are ignored.'
      );
    }
    return Promise.resolve();
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context?: unknown,
    _logger?: unknown
  ): ResolutionDetails<boolean> {
    return this.resolve('boolean', flagKey, defaultValue, context) as ResolutionDetails<boolean>;
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context?: unknown,
    _logger?: unknown
  ): ResolutionDetails<string> {
    return this.resolve('string', flagKey, defaultValue, context) as ResolutionDetails<string>;
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context?: unknown,
    _logger?: unknown
  ): ResolutionDetails<number> {
    return this.resolve('number', flagKey, defaultValue, context) as ResolutionDetails<number>;
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context?: unknown,
    _logger?: unknown
  ): ResolutionDetails<T> {
    return this.resolve('object', flagKey, defaultValue, context) as ResolutionDetails<T>;
  }

  /** Flush pending records and release the bridge subscription and the evaluator. */
  onClose(): Promise<void> {
    this.flush();
    this.closed = true;
    if (this.flushTimer !== undefined) {
      pageWorld.clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.evaluator.stop();
    this.evaluatable = false;
    for (const waiter of [...this.readyWaiters]) {
      waiter.reject(new ProviderNotReadyError('provider closed'));
    }
    return Promise.resolve();
  }

  private resolve(
    type: FlagValueType,
    flagKey: string,
    defaultValue: unknown,
    invocationContext: unknown
  ): ResolutionDetails<unknown> {
    const details = this.evaluator.resolve(type, flagKey, defaultValue);
    this.ledger.record(invocationContext, this.evaluator.contextRevision ?? this.contextRevision);
    return {
      value: details.value,
      variant: details.variant,
      reason: details.reason,
      errorCode: details.errorCode,
      flagMetadata: details.flagMetadata,
    };
  }

  private onSnapshotJson(json: unknown): void {
    if (this.closed || typeof json !== 'string') {
      // An excluded session gets no answer at all (undefined).
      return;
    }
    const snapshot = parseFlagsSnapshot(json);
    if (snapshot === undefined) {
      throw new Error('invalid feature flags snapshot');
    }
    this.applySnapshot(snapshot);
  }

  private applySnapshot(snapshot: FlagsSnapshot): void {
    // Minimal snapshots (pre-init NOT_READY, DISABLED) carry revision 0 and never
    // override a real snapshot; real snapshots apply only when newer.
    if (snapshot.revision === 0 ? this.revision > 0 : snapshot.revision <= this.revision) {
      return;
    }
    this.revision = snapshot.revision;
    this.snapshotStatus = snapshot.status;
    this.tracking = snapshot.tracking;
    this.contextRevision = snapshot.contextRevision;
    if (snapshot.configuration !== undefined || snapshot.status === 'ERROR') {
      this.evaluator.apply(snapshot);
    }
    const wasEvaluatable = this.evaluatable;
    const previousConfigurationRevision = this.configurationRevision;
    this.configurationRevision = snapshot.configurationRevision;
    this.evaluatable =
      (snapshot.status === 'READY' || snapshot.status === 'STALE') && snapshot.configuration !== undefined;

    if (snapshot.status === 'DISABLED') {
      for (const waiter of [...this.readyWaiters]) {
        waiter.reject(new ProviderNotReadyError('feature flags are disabled'));
      }
      return;
    }
    if (!this.evaluatable) {
      return;
    }
    if (!wasEvaluatable) {
      if (this.readyWaiters.size > 0) {
        // A pending initialize() resolves; the web-sdk emits Ready itself.
        for (const waiter of [...this.readyWaiters]) {
          waiter.resolve();
        }
      } else {
        // Recovery after a rejected initialize or an ERROR snapshot (D6).
        this.events.emit(ProviderEvents.Ready);
      }
      return;
    }
    if (snapshot.configurationRevision !== previousConfigurationRevision) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagConfiguration: {} });
    }
  }

  private buildTrackingHook(): Hook {
    return {
      finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        const contextRevision = this.ledger.take(hookContext.context) ?? this.contextRevision;
        this.guard(() => this.reportEvaluation(hookContext.flagKey, details, contextRevision));
      },
    };
  }

  private reportEvaluation(flagKey: string, details: EvaluationDetails<FlagValue>, contextRevision: number): void {
    if (this.bridge === undefined || this.closed) {
      return;
    }
    const record = buildEvaluationRecord(flagKey, details, contextRevision, timeStampNow());
    const exposureEligible =
      record.errorCode === undefined && record.reason !== 'ERROR' && record.variant !== undefined;
    if (this.tracking.rum && exposureEligible) {
      pageWorld.DD_RUM?.addFeatureFlagEvaluation?.(flagKey, record.variant);
    }
    if (!this.tracking.exposures && !this.tracking.evaluations) {
      return;
    }
    if (!this.tracking.evaluations) {
      // Exposure-only mode: main only needs one record per exposure tuple and revision.
      if (!exposureEligible || !record.doLog) {
        return;
      }
      const key = JSON.stringify([
        contextRevision,
        flagKey,
        record.variant,
        record.allocationKey,
        record.configurationId,
      ]);
      if (this.preDedupeKeys.has(key)) {
        return;
      }
      this.preDedupeKeys.add(key);
      if (this.preDedupeKeys.size > MAX_PREDEDUPE_KEYS) {
        this.preDedupeKeys.delete(this.preDedupeKeys.values().next().value as string);
      }
    }
    const view = pageWorld.DD_RUM?.getInternalContext?.()?.view;
    const viewUrl = view?.url ?? pageWorld.location?.href;
    if (view?.id !== undefined) record.viewId = view.id;
    if (viewUrl !== undefined) record.viewUrl = viewUrl.slice(0, MAX_VIEW_URL_LENGTH);
    this.enqueue(record);
  }

  private enqueue(record: EvaluationRecord): void {
    this.records.push(record);
    if (this.records.length >= FLUSH_THRESHOLD) {
      this.flush();
    } else {
      this.scheduleFlush();
    }
  }

  private scheduleFlush(): void {
    if (this.flushTimer === undefined && !this.closed) {
      this.flushTimer = pageWorld.setTimeout(() => {
        this.flushTimer = undefined;
        this.guard(() => this.flush());
      }, FLUSH_INTERVAL);
    }
  }

  /**
   * Send queued records and errors in batches of at most {@link MAX_RECORDS_PER_BATCH}
   * records and {@link MAX_BATCH_BYTES} of JSON; errors ride along with the first batch.
   */
  private flush(): void {
    if (this.bridge === undefined || (this.records.length === 0 && this.errors.length === 0)) {
      return;
    }
    const records = this.records;
    let errors = this.errors;
    this.records = [];
    this.errors = [];
    let batch: EvaluationRecord[] = [];
    let batchBytes = 0;
    const send = () => {
      const payload: EvaluationBatch = { records: batch };
      if (errors.length > 0) {
        payload.errors = errors;
        errors = [];
      }
      this.bridge!.sendEvaluations(JSON.stringify(payload));
      batch = [];
      batchBytes = 0;
    };
    const errorBytes = JSON.stringify(errors).length;
    for (const record of records) {
      const recordBytes = JSON.stringify(record).length + 1;
      const reserved = errors.length > 0 ? errorBytes : 0;
      if (
        batch.length > 0 &&
        (batch.length >= MAX_RECORDS_PER_BATCH || batchBytes + recordBytes + reserved + 32 > MAX_BATCH_BYTES)
      ) {
        send();
      }
      batch.push(record);
      batchBytes += recordBytes;
    }
    send();
  }

  /** Run renderer SDK code; an invariant throw is reported to main and never escapes. */
  private guard(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      this.reportError(error);
    }
  }

  private reportError(error: unknown): void {
    if (this.closed) {
      return;
    }
    if (this.errors.length < MAX_ERRORS_PER_BATCH) {
      const message = error instanceof Error ? error.message : String(error);
      const entry: { message: string; stack?: string } = { message: message.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH) };
      if (error instanceof Error && typeof error.stack === 'string') {
        entry.stack = error.stack.slice(0, MAX_BATCH_ERROR_MESSAGE_LENGTH);
      }
      this.errors.push(entry);
    }
    try {
      this.scheduleFlush();
    } catch {
      // The page-world timer is unavailable: errors ride along with the next batch.
    }
  }
}
