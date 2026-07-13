import { MainAssembly, RendererPipeline, createFormatHooks, registerCommonContext } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import type {
  AddDurationVitalOptions,
  DurationVitalOptions,
  ErrorOptions,
  FailureReason,
  FeatureOperationOptions,
} from './domain/rum';
import { callMonitored, startTelemetry } from './domain/telemetry';
import { EventManager } from './event';
import { Transport } from './transport';
import { Tracing } from './domain/tracing/Tracing';
import { SpanProcessor } from './domain/tracing/SpanProcessor';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;
let tracing: Tracing | undefined;

/**
 * Internal SDK context
 * Same format as Browser SDK
 */
export interface InternalContext {
  session_id: string;
}

/**
 * Internal SDK context
 */
export interface InternalContext {
  session_id: string;
}

/**
 * Initialize the Electron SDK
 */
export async function init(configuration: InitConfiguration): Promise<boolean> {
  const config = buildConfiguration(configuration);

  if (!config) {
    return false;
  }

  tracing = new Tracing();

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks, config);

  new MainAssembly(eventManager, hooks);
  new RendererPipeline(eventManager, hooks, config);

  if (tracing.enabled) {
    new SpanProcessor(eventManager, hooks, config);
  }

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
 * Add an already-completed custom duration vital.
 *
 * `startTime` is a UNIX timestamp in milliseconds and `duration` is expressed in milliseconds.
 *
 * @example
 * ```ts
 * addDurationVital('database.migration', {
 *   startTime: Date.now() - 1_500,
 *   duration: 1_500,
 *   context: { migration: 'users' },
 * });
 * ```
 */
export function addDurationVital(name: string, options: AddDurationVitalOptions): void {
  callMonitored(() => rumApi?.addDurationVital(name, options));
}

/**
 * Start measuring a custom duration vital.
 *
 * Use `vitalKey` when multiple instances with the same name can overlap. The matching stop call must happen in the
 * same Electron process.
 *
 * @example
 * ```ts
 * startDurationVital('document.open', { vitalKey: documentId });
 * await openDocument(documentId);
 * stopDurationVital('document.open', { vitalKey: documentId });
 * ```
 */
export function startDurationVital(name: string, options?: DurationVitalOptions): void {
  callMonitored(() => rumApi?.startDurationVital(name, options));
}

/**
 * Stop a custom duration vital started with `startDurationVital`.
 *
 * Context and description supplied here are merged with the start options.
 *
 * @example
 * ```ts
 * startDurationVital('cache.warmup');
 * await warmCache();
 * stopDurationVital('cache.warmup', { context: { entries: 42 } });
 * ```
 */
export function stopDurationVital(name: string, options?: DurationVitalOptions): void {
  callMonitored(() => rumApi?.stopDurationVital(name, options));
}

/**
 * Start a RUM Operation step.
 *
 * Pair every `startOperation` with exactly one `succeedOperation` or `failOperation`.
 * Use `options.operationKey` to distinguish parallel operations sharing the same name.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function startOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.startOperation(name, options));
}

/**
 * Record the successful completion of a RUM Operation started with `startOperation`.
 *
 * Pass the same `name` (and `operationKey`, if any) that was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function succeedOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.succeedOperation(name, options));
}

/**
 * Record the failure of a RUM Operation started with `startOperation`.
 *
 * Pass the same `name` (and `operationKey`, if any) that was used when starting the operation.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function failOperation(name: string, failureReason: FailureReason, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.failOperation(name, failureReason, options));
}

/**
 * @deprecated Use `startOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function startFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.startFeatureOperation(name, options));
}

/**
 * @deprecated Use `succeedOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function succeedFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => rumApi?.succeedFeatureOperation(name, options));
}

/**
 * @deprecated Use `failOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
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
  await tracing?.flush();
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

/**
 * Get the internal SDK context
 */
export function getInternalContext(): InternalContext | undefined {
  if (!sessionManager) {
    return undefined;
  }
  const sessionId = sessionManager.getTrackedSessionId();
  if (sessionId === undefined) {
    return undefined;
  }
  return { session_id: sessionId };
}

export type { InitConfiguration } from './config';
export type {
  AddDurationVitalOptions,
  DurationVitalOptions,
  FailureReason,
  FeatureOperationOptions,
  RumErrorEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalEvent,
  RumVitalDurationEvent,
  RumVitalOperationStepEvent,
} from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';
