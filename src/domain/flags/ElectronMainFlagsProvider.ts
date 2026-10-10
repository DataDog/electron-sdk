import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  ProviderNotReadyError,
  type EvaluationContext,
  type EvaluationDetails,
  type FlagValue,
  type FlagValueType,
  type JsonValue,
  type Hook,
  type HookContext,
  type ResolutionDetails,
} from '@openfeature/web-sdk';
import { timeStampNow } from '@datadog/js-core/time';
import { display } from '../../tools/display';
import { normalizeFlagsContext } from '../../common/flags/flagsContext';
import { buildEvaluationRecord, ResolutionLedger } from '../../common/flags/evaluationRecord';
import type { FlagsSnapshot, FlatContext } from '../../common/flags/types';
import { callMonitored, setTimeout as sdkSetTimeout, clearTimeout as sdkClearTimeout } from '../telemetry';

const DEFAULT_FETCH_TIMEOUT = 5000;
import { getFeatureFlagsController, registerFlagsProvider, type FeatureFlagsController } from './startFeatureFlags';

/**
 * The main-process OpenFeature provider for Datadog feature flags.
 *
 * It is the only way to set the flag context (D1): a context is *replaced*, never
 * merged, and `{}` falls back to the per-install anonymous key. The provider can be
 * constructed before `init()` — its context is then held and applied when the feature
 * flags subsystem starts. Constructing a second instance logs a warning; the last
 * context written wins.
 *
 * Evaluations are local and synchronous against the snapshot owned by main. The
 * provider's `finally` hook feeds the exposure collector and the main RUM flag
 * context; a throwing sink is reported to telemetry and does not change the returned
 * value.
 *
 * @example
 * ```ts
 * import { OpenFeature } from '@openfeature/web-sdk'
 * import { ElectronMainFlagsProvider } from '@datadog/electron-sdk'
 *
 * await datadogSdk.init({ /* ...options... *\/, featureFlags: {} })
 * await OpenFeature.setProviderAndWait(new ElectronMainFlagsProvider())
 * const client = OpenFeature.getClient()
 * const enabled = client.getBooleanValue('my-flag', false)
 * ```
 */
export class ElectronMainFlagsProvider {
  readonly metadata = { name: 'ElectronMainFlags' };
  readonly runsOn = 'client' as const;
  readonly events = new OpenFeatureEventEmitter();
  readonly hooks: Hook[] = [this.buildTrackingHook()];

  private controller?: FeatureFlagsController;
  private context?: EvaluationContext;
  private evaluatable = false;
  private configurationRevision = 0;
  private initializing = false;
  private warnedNoController = false;
  private readonly ledger = new ResolutionLedger();
  private readonly readyWaiters = new Set<() => void>();

  constructor() {
    registerFlagsProvider({
      onControllerStart: (controller) => {
        this.controller = controller;
        const current = controller.state.snapshot();
        this.evaluatable = current.configuration !== undefined;
        this.configurationRevision = current.configurationRevision;
        controller.state.subscribe((snapshot) => this.onSnapshot(snapshot));
        if (this.context !== undefined) {
          this.applyContextToController(this.context);
        }
        if (this.evaluatable) {
          this.notifyReadyWaiters();
        }
      },
    });
  }

  /**
   * Store the evaluation context and wait for a configuration. Called by the OpenFeature
   * web-sdk on `setProvider` — the context is replaced, never merged.
   */
  initialize(context: EvaluationContext = {}): Promise<void> {
    this.applyContext(context);
    if (this.evaluatable) {
      return Promise.resolve();
    }
    this.initializing = true;
    return this.waitForConfiguration().finally(() => {
      this.initializing = false;
    });
  }

  /** Resolve when a configuration is served (READY or STALE), reject after `fetchTimeout` (D6). */
  private waitForConfiguration(): Promise<void> {
    const timeoutMs = this.controller?.fetchTimeout ?? DEFAULT_FETCH_TIMEOUT;
    return new Promise<void>((resolve, reject) => {
      const onReady = () => {
        sdkClearTimeout(timeoutId);
        this.readyWaiters.delete(onReady);
        resolve();
      };
      const timeoutId = sdkSetTimeout(() => {
        this.readyWaiters.delete(onReady);
        reject(new ProviderNotReadyError('no flags configuration is available yet'));
      }, timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  private onSnapshot(snapshot: FlagsSnapshot): void {
    const wasEvaluatable = this.evaluatable;
    const previousConfigurationRevision = this.configurationRevision;
    this.evaluatable = snapshot.configuration !== undefined;
    this.configurationRevision = snapshot.configurationRevision;
    if (!this.evaluatable) {
      return;
    }
    if (!wasEvaluatable) {
      if (this.readyWaiters.size > 0 || this.initializing) {
        // A pending initialize() resolves and the web-sdk emits Ready itself.
        this.notifyReadyWaiters();
      } else {
        // Recovery after a rejected initialize or an ERROR state (D6).
        this.events.emit(ProviderEvents.Ready);
      }
      return;
    }
    if (snapshot.configurationRevision !== previousConfigurationRevision) {
      this.events.emit(ProviderEvents.ConfigurationChanged, { flagConfiguration: {} });
    }
  }

  private notifyReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) {
      waiter();
    }
  }

  /** Replace the evaluation context (D1b): `{}` falls back to the anonymous key. */
  onContextChange(_oldContext: EvaluationContext | undefined, newContext: EvaluationContext = {}): Promise<void> {
    this.applyContext(newContext);
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

  private resolve(
    type: FlagValueType,
    flagKey: string,
    defaultValue: unknown,
    invocationContext: unknown
  ): ResolutionDetails<boolean | string | number | Record<string, unknown>> {
    const controller = this.controller;
    if (controller === undefined) {
      if (!this.warnedNoController) {
        this.warnedNoController = true;
        display.warn(
          'Feature flags are not started; evaluations return the application default. Initialize the SDK with the featureFlags option.'
        );
      }
      return {
        value: defaultValue as boolean | string | number | Record<string, unknown>,
        reason: 'ERROR',
        errorCode: ErrorCode.PROVIDER_NOT_READY,
      };
    }
    const result = controller.evaluator.resolve(type, flagKey, defaultValue);
    // Captured now: an `after` hook may change the context before `finally` runs (B8).
    this.ledger.record(
      invocationContext,
      controller.evaluator.contextRevision ?? controller.state.snapshot().contextRevision
    );
    return {
      value: result.value,
      variant: result.variant,
      reason: result.reason,
      errorCode: result.errorCode,
      flagMetadata: result.flagMetadata,
    };
  }

  private applyContext(context: EvaluationContext): void {
    this.context = context;
    if (this.controller === undefined) {
      return;
    }
    this.applyContextToController(context);
  }

  private applyContextToController(context: EvaluationContext): void {
    const controller = this.controller;
    if (controller === undefined) {
      return;
    }
    const { context: normalized, droppedKeys } = normalizeFlagsContext(context, controller.keyStore.anonymousKey);
    if (droppedKeys.length > 0) {
      display.warn(`Dropped feature flags context attributes: ${droppedKeys.join(', ')}`);
    }
    if (JSON.stringify(controller.state.snapshot().context) !== JSON.stringify(normalized)) {
      controller.state.applyContextUpdate(normalized);
    }
  }

  /**
   * The provider's `finally` hook: every evaluation (defaults and errors included) is
   * reported with the context revision captured at resolution, so exposures, main RUM
   * correlation and evaluation metrics each apply their own rules. A throwing sink is
   * reported to telemetry and never changes the returned value.
   */
  private buildTrackingHook(): Hook {
    return {
      finally: (hookContext: HookContext, details: EvaluationDetails<FlagValue>) => {
        const contextRevision = this.ledger.take(hookContext.context);
        callMonitored(() => {
          const controller = this.controller;
          if (controller === undefined) {
            return;
          }
          controller.recordEvaluation(
            buildEvaluationRecord(
              hookContext.flagKey,
              details,
              contextRevision ?? controller.state.snapshot().contextRevision,
              timeStampNow()
            )
          );
        });
      },
    };
  }
}

export { getFeatureFlagsController };
export type { FlatContext };
