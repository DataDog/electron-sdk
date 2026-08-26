import { app } from 'electron';
import { MainAssembly, RendererPipeline, createFormatHooks, registerCommonContext } from './assembly';
import { setDurationVitalApi } from './api';
import type { AccountInfo, UserInfo } from './domain/customer-context';
import { AccountContext, UserContext } from './domain/customer-context';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import type { ErrorOptions, FailureReason, FeatureOperationOptions } from './domain/rum';
import { RumCollection } from './domain/rum';
import { ReplayCollection } from './domain/replay';
import { SessionManager } from './domain/session';
import { addUsage, callMonitored, reportConfiguration, startTelemetry } from './domain/telemetry';
import { SpanProcessor } from './domain/tracing/SpanProcessor';
import { Tracing } from './domain/tracing/Tracing';
import { ProfilingCollection } from './domain/profiling';
import { EventManager } from './event';
import { BeforeQuitHandler } from './tools/BeforeQuitHandler';
import { Transport } from './transport';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;
let tracing: Tracing | undefined;
let userContext: UserContext | undefined;
let accountContext: AccountContext | undefined;
let replayCollection: ReplayCollection | undefined;
let beforeQuitHandler: BeforeQuitHandler | undefined;

/**
 * Internal SDK context
 * Same format as Browser SDK
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

  tracing = new Tracing(config);

  eventManager = new EventManager();
  const hooks = createFormatHooks();

  registerCommonContext(config, hooks);
  userContext = await UserContext.init(hooks);
  accountContext = await AccountContext.init(hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks, config);

  new MainAssembly(eventManager, hooks);
  new RendererPipeline(eventManager, hooks, config);

  new ProfilingCollection(eventManager, sessionManager, config, hooks);
  replayCollection = new ReplayCollection(eventManager, config, sessionManager, hooks);

  if (tracing.enabled) {
    new SpanProcessor(eventManager, hooks, config);
  }

  transport = await Transport.create(config, eventManager);
  const rum = await RumCollection.start(eventManager, hooks);
  rumApi = rum.getApi();
  setDurationVitalApi(rumApi);

  beforeQuitHandler?.stop();
  beforeQuitHandler = new BeforeQuitHandler(app, _flushTransport);

  // Reported last: the transport must be registered for the event to reach a batch, and every
  // component whose state it describes must be constructed. Monitored so a failure anywhere in the
  // telemetry pipeline degrades telemetry rather than rejecting `init()`.
  const { telemetryInitialized: useTracing, version: tracerVersion } = tracing;
  callMonitored(() => reportConfiguration(config, { useTracing, tracerVersion }));

  return true;
}

/**
 * Stop the current session
 */
export function stopSession(): void {
  callMonitored(() => {
    addUsage({ feature: 'stop-session' });
    sessionManager?.expire();
  });
}

/**
 * Set the user information. The user info is attached to all subsequent supported events.
 * An `id` is required: calls without one are ignored (with a warning). To attach attributes to a
 * user whose `id` is managed elsewhere (e.g. derived from `anonymous_id`), use `addUserExtraInfo`.
 * @param user - The user information, including an `id`.
 * @example
 * setUserInfo({ id: 'user-123', name: 'Alice', email: 'alice@example.com' });
 * addUserExtraInfo({ plan: 'premium' });
 * // Later, when the user logs out:
 * clearUserInfo();
 */
export function setUserInfo(user: UserInfo & { id: string }): void {
  callMonitored(() => {
    addUsage({ feature: 'set-user' });
    userContext?.setUserInfo(user);
  });
}

/**
 * Return a copy of the current user information, or `undefined` if none is set.
 * @example
 * const user = getUserInfo(); // { id: 'user-123', name: 'Alice' }
 */
export function getUserInfo(): UserInfo | undefined {
  return callMonitored(() => {
    addUsage({ feature: 'get-user' });
    return userContext?.getInfo();
  });
}

/**
 * Clear all user information from subsequent supported events.
 * @example
 * clearUserInfo();
 */
export function clearUserInfo(): void {
  callMonitored(() => {
    addUsage({ feature: 'clear-user' });
    userContext?.clearContext();
  });
}

/**
 * Add custom attributes to the current user, merged into its `extraInfo`.
 * Set an attribute value to `null` to remove it.
 * Standard fields (`id`, `name`, `email`) can only be set via `setUserInfo`.
 * Works even when no user has been set, so attributes can be attached to a user whose `id` is
 * derived elsewhere (e.g. from `anonymous_id`).
 * @param extraInfo - Custom attributes to merge into the user's `extraInfo`.
 * @example
 * addUserExtraInfo({ plan: 'premium', role: 'admin' });
 * // Remove an attribute by setting it to null:
 * addUserExtraInfo({ role: null });
 */
export function addUserExtraInfo(extraInfo: Record<string, unknown>): void {
  callMonitored(() => {
    addUsage({ feature: 'set-user-property' });
    userContext?.addExtraInfo(extraInfo);
  });
}

/**
 * Set the account information. The account info is attached to all subsequent supported events.
 * An `id` is required: calls without one are ignored (with a warning).
 * @param accountInfo - The account information containing at least an `id`.
 * @example
 * setAccountInfo({ id: 'account-456', name: 'Acme Corp' });
 * addAccountExtraInfo({ tier: 'enterprise' });
 * // Later, when the account is no longer active:
 * clearAccountInfo();
 */
export function setAccountInfo(accountInfo: AccountInfo): void {
  callMonitored(() => {
    addUsage({ feature: 'set-account' });
    accountContext?.setContext(accountInfo);
  });
}

/**
 * Return a copy of the current account information, or `undefined` if none is set.
 * @example
 * const account = getAccountInfo(); // { id: 'account-456', name: 'Acme Corp' }
 */
export function getAccountInfo(): AccountInfo | undefined {
  return callMonitored(() => {
    addUsage({ feature: 'get-account' });
    return accountContext?.getInfo();
  });
}

/**
 * Clear all account information from subsequent supported events.
 * @example
 * clearAccountInfo();
 */
export function clearAccountInfo(): void {
  callMonitored(() => {
    addUsage({ feature: 'clear-account' });
    accountContext?.clearContext();
  });
}

/**
 * Add custom attributes to the current account, merged into its `extraInfo`.
 * Set an attribute value to `null` to remove it.
 * Standard fields (`id`, `name`) can only be set via `setAccountInfo`.
 * Requires `setAccountInfo` to have been called first; otherwise the call is ignored.
 * @param extraInfo - Custom attributes to merge into the account's `extraInfo`.
 * @example
 * addAccountExtraInfo({ tier: 'enterprise', region: 'us' });
 * // Remove an attribute by setting it to null:
 * addAccountExtraInfo({ region: null });
 */
export function addAccountExtraInfo(extraInfo: Record<string, unknown>): void {
  callMonitored(() => {
    addUsage({ feature: 'set-account-property' });
    accountContext?.addExtraInfo(extraInfo);
  });
}

/**
 * Report a manually handled error
 */
export function addError(error: unknown, options?: ErrorOptions): void {
  callMonitored(() => {
    addUsage({ feature: 'add-error' });
    rumApi?.addError(error, options);
  });
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
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'start' });
    rumApi?.startOperation(name, options);
  });
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
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'succeed' });
    rumApi?.succeedOperation(name, options);
  });
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
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'fail' });
    rumApi?.failOperation(name, failureReason, options);
  });
}

/**
 * @deprecated Use `startOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function startFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'start' });
    rumApi?.startFeatureOperation(name, options);
  });
}

/**
 * @deprecated Use `succeedOperation` instead. This alias exists for backwards compatibility with the API name used in
 * early previews and will be removed in a future major release.
 *
 * @experimental This API is in preview and may change in future releases.
 * @see README "Operation Monitoring" for usage details.
 */
export function succeedFeatureOperation(name: string, options?: FeatureOperationOptions): void {
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'succeed' });
    rumApi?.succeedFeatureOperation(name, options);
  });
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
  callMonitored(() => {
    addUsage({ feature: 'add-operation-step-vital', action_type: 'fail' });
    rumApi?.failFeatureOperation(name, failureReason, options);
  });
}

/**
 * Internal API to flush all pending batches to the intake
 */
export async function _flushTransport(): Promise<void> {
  // 1. Produce the final replay segment (compress + hand it to the batch producer).
  // 2. Flush the transport so that segment is written and uploaded. stop() alone only queues it in
  //    the producer; the write/upload happens in transport.flush().
  // 3. Flush tracing: dd-trace turns its batched spans into RUM resource/SPANS events synchronously.
  // 4. Flush the transport again to upload those tracing-produced events.
  await replayCollection?.stop();
  await transport?.flush();
  await tracing?.flush();
  await transport?.flush();
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

export { addDurationVital, startDurationVital, stopDurationVital } from './api';
export type { AccountInfo, UserInfo } from './domain/customer-context';
export type { InitConfiguration, TraceSamplingRule } from './config';
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
export type {
  TelemetryConfigurationEvent,
  TelemetryDebugEvent,
  TelemetryErrorEvent,
  TelemetryEvent,
  TelemetryUsageEvent,
} from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';
