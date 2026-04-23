import { Assembly, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import { UserActivityTracker } from './domain/UserActivityTracker';
import type { ErrorOptions, FailureReason, FeatureOperationOptions } from './domain/rum';
import { callMonitored, startTelemetry } from './domain/telemetry';
import { EventManager } from './event';
import { BridgeHandler, registerPreload } from './bridge';
import { Transport } from './transport';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;

/**
 * Initialize the Electron SDK
 */
export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  // register preload early to avoid missing windows creation before init is complete
  registerPreload();
  eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks);

  new Assembly(eventManager, hooks);
  new BridgeHandler(eventManager, config);
  new UserActivityTracker(eventManager);

  transport = await Transport.create(config, eventManager);
  const rum = await RumCollection.start(eventManager, hooks);
  rumApi = rum.getApi();

  return true;
}

/**
 * Stop the current session
 */
export function stopSession(): void {
  callMonitored(() => sessionManager?.expire());
}

/**
 * Report a manually handled error
 */
export function addError(error: unknown, options?: ErrorOptions): void {
  callMonitored(() => rumApi?.addError(error, options));
}

/**
 * Start a RUM Operation step from the main process.
 *
 * Emits a vital `operation_step` event with `step_type: "start"`.
 * Pair every `startFeatureOperation` with exactly one `succeedFeatureOperation`
 * or `failFeatureOperation`. Use `options.operationKey` to distinguish parallel
 * operations with the same name.
 *
 * Renderer consumers should continue to call `DD_RUM.startFeatureOperation`
 * on the bundled `@datadog/browser-rum` (with `feature_operation_vital`
 * experimental flag enabled) — the API signatures match. An operation started
 * in one process may be completed in the other; the backend correlates start
 * and end steps by `name` + `operationKey`.
 *
 * The main-process API does not maintain any local active-operation tracking
 * (by design — renderer-originated start/stop events cross the IPC bridge
 * without updating main-process state, so local tracking would produce false
 * "duplicate start" / "stop without start" warnings on legitimate cross-
 * process flows). This matches the bundled browser-sdk's behavior.
 *
 * @experimental This API is in preview and may change in future releases.
 * @example
 * startFeatureOperation('checkout');
 * // ... later
 * succeedFeatureOperation('checkout');
 *
 * // Parallel operations with distinct keys
 * startFeatureOperation('upload', { operationKey: 'profile_pic' });
 * startFeatureOperation('upload', { operationKey: 'cover_photo' });
 */
export function startFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.startFeatureOperation(name, options));
}

/**
 * Record the successful completion of a RUM Operation started with
 * `startFeatureOperation`.
 *
 * Emits a vital `operation_step` event with `step_type: "end"` and no
 * `failure_reason`. Pass the same `name` (and `operationKey`, if any) that
 * was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @example
 * succeedFeatureOperation('upload', { operationKey: 'profile_pic' });
 */
export function succeedFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.succeedFeatureOperation(name, options));
}

/**
 * Record the failure of a RUM Operation started with `startFeatureOperation`.
 *
 * Emits a vital `operation_step` event with `step_type: "end"` and the
 * supplied `failureReason`. Pass the same `name` (and `operationKey`, if any)
 * that was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @example
 * failFeatureOperation('checkout', 'error');
 * failFeatureOperation('upload', 'abandoned', { operationKey: 'cover_photo' });
 */
export function failFeatureOperation(
  name: string,
  failureReason: FailureReason,
  options?: FeatureOperationOptions
): void {
  callMonitored(() => rumApi?.failFeatureOperation(name, failureReason, options));
}

/**
 * Internal API to flush all pending batches to the intake
 */
export async function _flushTransport(): Promise<void> {
  await transport?.flush();
}

/*
 * Internal API to test monitoring
 * TODO replace with the usage of another API when available
 */
export function _generateTelemetryError() {
  return callMonitored(() => {
    throw new Error('expected error');
  });
}

export type { InitConfiguration } from './config';
export type {
  FailureReason,
  FeatureOperationOptions,
  RumErrorEvent,
  RumViewEvent,
  RumVitalEvent,
  RumVitalOperationStepEvent,
} from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';
