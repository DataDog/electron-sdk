import type { AccountInfo, UserInfo } from './domain/customer-context';
import { AccountContext, UserContext } from './domain/customer-context';
import { createFormatHooks, MainAssembly, registerCommonContext, RendererPipeline } from './assembly';
import type { InitConfiguration } from './config';
import { buildConfiguration } from './config';
import type { ErrorOptions, FailureReason, FeatureOperationOptions } from './domain/rum';
import { RumCollection } from './domain/rum';
import { SessionManager } from './domain/session';
import { callMonitored, startTelemetry } from './domain/telemetry';
import { SpanProcessor } from './domain/tracing/SpanProcessor';
import { Tracing } from './domain/tracing/Tracing';
import { ProfilingCollection } from './domain/profiling';
import { EventManager } from './event';
import { Transport } from './transport';

let sessionManager: SessionManager | undefined;
let eventManager: EventManager | undefined;
let transport: Transport | undefined;
let rumApi: ReturnType<RumCollection['getApi']> | undefined;
let tracing: Tracing | undefined;
let userContext: UserContext | undefined;
let accountContext: AccountContext | undefined;

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
  userContext = new UserContext(hooks);
  accountContext = new AccountContext(hooks);
  startTelemetry(eventManager, config);
  sessionManager = await SessionManager.start(eventManager, hooks, config);

  new MainAssembly(eventManager, hooks);
  new RendererPipeline(eventManager, hooks, config);

  new ProfilingCollection(eventManager, sessionManager, config, hooks);

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
 * Set the user information. The user info is attached to all subsequent RUM events.
 * An `id` is required: calls without one are ignored (with a warning). To attach attributes to a
 * user whose `id` is managed elsewhere (e.g. derived from `anonymous_id`), use `addUserExtraInfo`.
 * @param user - The user information, including an `id`.
 */
export function setUserInfo(user: UserInfo & { id: string }): void {
  callMonitored(() => userContext?.setUserInfo(user));
}

/**
 * Return a copy of the current user information, or `undefined` if none is set.
 */
export function getUserInfo(): UserInfo | undefined {
  return userContext?.getInfo();
}

/**
 * Clear all user information.
 */
export function clearUserInfo(): void {
  callMonitored(() => userContext?.clearContext());
}

/**
 * Add custom attributes to the current user, merged into its `extraInfo`.
 * Standard fields (`id`, `name`, `email`) can only be set via `setUserInfo`.
 * Works even when no user has been set, so attributes can be attached to a user whose `id` is
 * derived elsewhere (e.g. from `anonymous_id`).
 * @param extraInfo - Custom attributes to merge into the user's `extraInfo`.
 */
export function addUserExtraInfo(extraInfo: Record<string, unknown>): void {
  callMonitored(() => userContext?.addExtraInfo(extraInfo));
}

/**
 * Set the account information. The account info is attached to all subsequent RUM events.
 * @param accountInfo - The account information containing at least an `id`.
 */
export function setAccountInfo(accountInfo: AccountInfo): void {
  callMonitored(() => accountContext?.setContext(accountInfo));
}

/**
 * Return a copy of the current account information, or `undefined` if none is set.
 */
export function getAccountInfo(): AccountInfo | undefined {
  return accountContext?.getInfo();
}

/**
 * Clear all account information.
 */
export function clearAccountInfo(): void {
  callMonitored(() => accountContext?.clearContext());
}

/**
 * Add custom attributes to the current account, merged into its `extraInfo`.
 * Standard fields (`id`, `name`) can only be set via `setAccountInfo`.
 * Requires `setAccountInfo` to have been called first; otherwise the call is ignored.
 * @param extraInfo - Custom attributes to merge into the account's `extraInfo`.
 */
export function addAccountExtraInfo(extraInfo: Record<string, unknown>): void {
  callMonitored(() => accountContext?.addExtraInfo(extraInfo));
}

/**
 * Report a manually handled error
 */
export function addError(error: unknown, options?: ErrorOptions): void {
  callMonitored(() => rumApi?.addError(error, options));
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

export type { AccountInfo, UserInfo } from './domain/customer-context';
export type { InitConfiguration } from './config';
export type {
  FailureReason,
  FeatureOperationOptions,
  RumErrorEvent,
  RumResourceEvent,
  RumViewEvent,
  RumVitalEvent,
  RumVitalOperationStepEvent,
} from './domain/rum';
export type { TelemetryErrorEvent } from './domain/telemetry';

export { SESSION_TIME_OUT_DELAY } from './domain/session';
