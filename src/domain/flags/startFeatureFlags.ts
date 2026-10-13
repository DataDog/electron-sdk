import { app, session as electronSession } from 'electron';
import type { EventManager } from '../../event';
import { display } from '../../tools/display';
import { addError as addTelemetryError, callMonitored } from '../telemetry';
import type { Configuration } from '../../config';
import type { FormatHooks } from '../../assembly';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import type { EvaluationRecord, FlagsSnapshot, FlagsTracking, FlatContext } from '../../common/flags/types';
import { AnonymousKeyStore } from './AnonymousKeyStore';
import { ConfigurationCache } from './ConfigurationCache';
import { ExposureCollector } from './ExposureCollector';
import { FeatureFlagsRumContext } from './FeatureFlagsRumContext';
import { SnapshotPublisher, startDisabledFlagsResponder } from './SnapshotPublisher';
import { getFlagsHolder } from '../../common/flags/flagsHolder';
import { EvaluationRecordReceiver } from './EvaluationRecordReceiver';
import { EvaluationBatchIntake } from './EvaluationBatchIntake';
import { disableFlagsChildren, linkFlagsChildren } from './ChildFlagsHub';
import { startEvaluationAggregator } from './EvaluationAggregator';
import { isAllowedRendererFrame } from '../../assembly';
import { FlagsOwner } from './FlagsOwner';
import { FlagsState } from './FlagsState';
import { RulesFetcher, MAX_CONFIGURATION_LENGTH } from './RulesFetcher';
import { PrecomputedFetcher } from './PrecomputedFetcher';
import { PrecomputedCache } from './PrecomputedCache';
import { PrecomputedOwner } from './PrecomputedOwner';

/**
 * Process-global holder linking `init()` (which creates the controller) with
 * `ElectronMainFlagsProvider` instances created by the application (D14/M3.5). The
 * provider can be constructed before `init()`: its context is then held and applied
 * when the controller starts.
 */
const CONTROLLER_HOLDER = Symbol.for('@datadog/electron-sdk:flags');
const PROVIDER_HOLDER = Symbol.for('@datadog/electron-sdk:flagsProvider');

interface ControllerHolder {
  controller?: FeatureFlagsController;
}
interface ProviderHolder {
  provider?: ElectronMainFlagsProviderLike;
}

export interface FeatureFlagsController {
  state: FlagsState;
  keyStore: AnonymousKeyStore;
  evaluator: FlagsEvaluator;
  tracking: FlagsTracking;
  fetchTimeout: number;
  /** Fan a main-process evaluation out to every enabled sink (exposures, main RUM, metrics). */
  recordEvaluation: (record: EvaluationRecord) => void;
  /**
   * Apply a normalized context change (already anonymous-key-resolved). In `rules` mode it
   * publishes immediately; in `precomputed` mode it fetches the assignments for the new
   * context and the returned promise settles once they (or their failure state) are applied
   * (D25) — so `await OpenFeature.setContext()` and child context responses wait for them.
   */
  applyContextChange: (context: FlatContext) => void | Promise<void>;
  /** Resolves once the in-flight configuration fetch has been applied. */
  settled: () => Promise<void>;
  /**
   * Release every resource. Open child channels are closed, unless `keepChildChannels` (re-init
   * and startup rollback: the channels stay open and answer the next controller or `DISABLED`).
   */
  stop: (options?: { keepChildChannels?: boolean }) => Promise<void>;
}

export interface ElectronMainFlagsProviderLike {
  onControllerStart: (controller: FeatureFlagsController) => void;
}

function getControllerHolder(): ControllerHolder {
  const holder = (globalThis as Record<symbol, ControllerHolder>)[CONTROLLER_HOLDER];
  if (holder !== undefined) {
    return holder;
  }
  const created: ControllerHolder = {};
  (globalThis as Record<symbol, ControllerHolder>)[CONTROLLER_HOLDER] = created;
  return created;
}

function getProviderHolder(): ProviderHolder {
  const holder = (globalThis as Record<symbol, ProviderHolder>)[PROVIDER_HOLDER];
  if (holder !== undefined) {
    return holder;
  }
  const created: ProviderHolder = {};
  (globalThis as Record<symbol, ProviderHolder>)[PROVIDER_HOLDER] = created;
  return created;
}

/**
 * Start the feature flags subsystem when `featureFlags` is enabled (M3.7). Creates the
 * state, the anonymous key store, the fetcher, the disk cache, the exposure collector,
 * the main RUM flag context, the evaluation metrics, the snapshot publisher and the
 * renderer record receiver, and links any provider the application already constructed.
 * The owner starts last: the cached configuration is served (STALE) to every linked
 * component before the first network fetch, which is never awaited (B12). Returns the
 * controller, or `undefined` when flags are disabled.
 */
export async function startFeatureFlags(
  configuration: Configuration,
  deps: FeatureFlagsDependencies
): Promise<FeatureFlagsController | undefined> {
  if (configuration.featureFlags === undefined) {
    return undefined;
  }
  // Re-initialization (B8): `init()` may run again, so the previous controller releases its
  // timers, listeners and global holders before a new one acquires them. Open child channels
  // stay open and are linked to the new controller.
  await stopFeatureFlags({ keepChildChannels: true });
  const undo: (() => void | Promise<void>)[] = [];
  try {
    return await startFlagsSubsystem(configuration, configuration.featureFlags, deps, undo);
  } catch (error) {
    // A partial startup failure (B6): release what was already set up, in reverse order, and
    // fall back to flags off. `init()` never rejects because of flags.
    for (const step of undo.reverse()) {
      try {
        await step();
      } catch {
        // Best effort: keep releasing the remaining resources.
      }
    }
    addTelemetryError(error);
    display.error('Feature flags failed to start; flags are disabled and evaluations return the application defaults.');
    startDisabledFlagsResponder();
    disableFlagsChildren();
    return undefined;
  }
}

/** Stop the running feature flags controller, if any, releasing every resource it holds. */
export async function stopFeatureFlags(options?: { keepChildChannels?: boolean }): Promise<void> {
  await getControllerHolder().controller?.stop(options);
}

interface FeatureFlagsDependencies {
  eventManager: EventManager;
  hooks: FormatHooks;
  mainViewEmitter: {
    findViewId: (atTime: import('@datadog/js-core/time').TimeStamp) => string | undefined;
    requestViewUpdate: () => void;
  };
  /** Test seam: overrides the fetch implementation used for rules requests. */
  fetch?: typeof globalThis.fetch;
}

async function startFlagsSubsystem(
  configuration: Configuration,
  flagsConfiguration: NonNullable<Configuration['featureFlags']>,
  deps: FeatureFlagsDependencies,
  undo: (() => void | Promise<void>)[]
): Promise<FeatureFlagsController> {
  const userDataPath = app.getPath('userData');
  const keyStore = await AnonymousKeyStore.init(userDataPath);
  const tracking: FlagsTracking = {
    exposures: flagsConfiguration.enableExposureLogging,
    rum: flagsConfiguration.enableRumFeatureFlagTracking,
    evaluations: flagsConfiguration.enableFlagEvaluationTracking,
  };
  const env = flagsConfiguration.env ?? '';
  const flaggingProxy =
    flagsConfiguration.flaggingProxy !== undefined ? { flaggingProxy: flagsConfiguration.flaggingProxy } : {};
  const fetchOptions = {
    clientToken: configuration.clientToken,
    site: configuration.site,
    env,
    ...flaggingProxy,
    fetchTimeout: flagsConfiguration.fetchTimeout,
    maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
    ...(configuration.applicationId !== undefined ? { applicationId: configuration.applicationId } : {}),
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  };
  const evaluationMode = flagsConfiguration.evaluationMode;
  // The fetcher and the disk cache are per mode: rules are identity-independent and cached
  // by environment (D7); precomputed assignments are per context and cached per context (D28).
  const fetcher =
    evaluationMode === 'precomputed' ? new PrecomputedFetcher(fetchOptions) : new RulesFetcher(fetchOptions);
  const cache =
    evaluationMode === 'precomputed'
      ? await PrecomputedCache.init({
          userDataPath,
          site: configuration.site,
          env,
          clientToken: configuration.clientToken,
          ...flaggingProxy,
          applicationId: configuration.applicationId,
          persistConfiguration: flagsConfiguration.persistConfiguration,
        })
      : await ConfigurationCache.init({
          userDataPath,
          site: configuration.site,
          env,
          clientToken: configuration.clientToken,
          ...flaggingProxy,
          persistConfiguration: flagsConfiguration.persistConfiguration,
        });

  const state = new FlagsState({ targetingKey: keyStore.anonymousKey }, tracking);
  const evaluator = new FlagsEvaluator();
  const evaluatorSubscription = state.subscribe((snapshot) => {
    evaluator.apply(snapshot);
  });
  undo.push(() => {
    evaluatorSubscription.unsubscribe();
    evaluator.stop();
  });
  evaluator.apply(state.snapshot());

  const collector = new ExposureCollector(
    state,
    { applicationId: configuration.applicationId, service: configuration.service },
    (event) => {
      deps.eventManager.notify(event);
    }
  );
  undo.push(() => collector.stop());
  const rumContext = new FeatureFlagsRumContext({
    hooks: deps.hooks,
    findViewId: deps.mainViewEmitter.findViewId,
    requestViewUpdate: deps.mainViewEmitter.requestViewUpdate,
    enabled: () => tracking.rum,
  });
  undo.push(() => rumContext.stop());
  const evaluationAggregator = startEvaluationAggregator(
    state,
    {
      service: configuration.service,
      applicationId: configuration.applicationId,
      enableFlagEvaluationTracking: flagsConfiguration.enableFlagEvaluationTracking,
    },
    deps.eventManager
  );

  /**
   * The shared tracking fan-out (B9): main, renderer and child records reach the same
   * sinks. Exposures and metrics take every record (the collector applies the upstream
   * skip rules, metrics count defaults and errors too); main RUM correlation takes main and
   * child records with a variant, since renderers report to their own `DD_RUM`. Child
   * records are attributed to the main process (D19): their view fields are dropped. Each
   * sink is isolated so a throwing sink is reported and never starves the others.
   */
  const fanOut = (input: EvaluationRecord, source: 'main' | 'renderer' | 'child') => {
    const record = source === 'child' ? withoutViewAttribution(input) : input;
    if (tracking.exposures) {
      callMonitored(() => collector.add(record));
    }
    if (source !== 'renderer' && tracking.rum && record.variant !== undefined && record.errorCode === undefined) {
      callMonitored(() => rumContext.record(record.flagKey, record.variant!, record.timestamp));
    }
    if (evaluationAggregator !== undefined) {
      callMonitored(() => evaluationAggregator.add(record));
    }
  };

  undo.push(() => evaluationAggregator?.stop());

  const isSenderExcluded = createSessionExclusion(flagsConfiguration.excludedPartitions);
  getFlagsHolder().isSenderExcluded = isSenderExcluded;
  undo.push(() => {
    if (getFlagsHolder().isSenderExcluded === isSenderExcluded) {
      getFlagsHolder().isSenderExcluded = undefined;
    }
  });
  const publisher = new SnapshotPublisher(state, configuration.allowedRendererHosts, isSenderExcluded);
  publisher.start();
  undo.push(() => publisher.stop());
  // One intake for renderers and children: the dropped-record telemetry is rate-limited per process.
  const intake = new EvaluationBatchIntake((record, source) => fanOut(record, source));
  const recordReceiver = new EvaluationRecordReceiver({
    onRecord: (record) => fanOut(record, 'renderer'),
    intake,
    isAllowedSender: (frame, sender) =>
      !isSenderExcluded(sender) && isAllowedRendererFrame(frame, configuration.allowedRendererHosts),
  });
  recordReceiver.start();
  undo.push(() => recordReceiver.stop());
  const unlinkChildren = linkFlagsChildren({
    state,
    intake,
    keyStore,
    // In precomputed mode a child context response waits for the assignments (§11.3).
    applyContextChange: (context) => applyContextChange(context),
  });
  undo.push(() => unlinkChildren({ closeChannels: false }));
  // Started last, after everything is linked; the controller may be stopped before that.
  const ownerRef: { current?: FlagsOwner | PrecomputedOwner } = {};
  const applyContextChange = (context: FlatContext): void | Promise<void> => {
    const owner = ownerRef.current;
    if (owner instanceof PrecomputedOwner) {
      // An identical context with nothing in flight is a no-op (D20): no new revision, no
      // request. Anything else goes to the owner, which awaits a matching in-flight
      // assignments fetch (a duplicate) or supersedes it with the new request (D25) —
      // including a reversion back to the served context while a different one is pending.
      if (owner.pendingContext === undefined && contextEquals(state.snapshot().context, context)) {
        return;
      }
      return owner.requestContext(context);
    }
    // Rules mode, or a context held before the owner starts (applied as the startup
    // context): an identical context is a no-op — no new revision, no fetch.
    if (!contextEquals(state.snapshot().context, context)) {
      state.applyContextUpdate(context);
    }
  };

  const controller: FeatureFlagsController = {
    state,
    keyStore,
    evaluator,
    tracking,
    fetchTimeout: flagsConfiguration.fetchTimeout,
    recordEvaluation: (record) => fanOut(record, 'main'),
    applyContextChange,
    settled: () => ownerRef.current?.settled() ?? Promise.resolve(),
    stop: async (options = {}) => {
      if (getControllerHolder().controller === controller) {
        getControllerHolder().controller = undefined;
      }
      recordReceiver.stop();
      publisher.stop();
      unlinkChildren({ closeChannels: options.keepChildChannels !== true });
      if (getFlagsHolder().isSenderExcluded === isSenderExcluded) {
        getFlagsHolder().isSenderExcluded = undefined;
      }
      await ownerRef.current?.stop();
      collector.stop();
      rumContext.stop();
      evaluationAggregator?.stop();
      evaluatorSubscription.unsubscribe();
      evaluator.stop();
    },
  };
  getControllerHolder().controller = controller;
  // From here the controller owns every resource: rolling back is stopping it.
  undo.splice(0, undo.length, () => controller.stop({ keepChildChannels: true }));

  // Link a provider constructed before init(): its context is applied now.
  const pendingProvider = getProviderHolder().provider;
  if (pendingProvider !== undefined) {
    pendingProvider.onControllerStart(controller);
  }

  // Everything is linked: serving the cache (STALE) now reaches the evaluator, the
  // publisher and the provider, then the first network fetch runs in the background.
  ownerRef.current =
    evaluationMode === 'precomputed'
      ? PrecomputedOwner.start({
          refreshInterval: flagsConfiguration.refreshInterval,
          state,
          fetcher: fetcher as PrecomputedFetcher,
          cache: cache as PrecomputedCache,
          keyStore,
        })
      : FlagsOwner.start({
          refreshInterval: flagsConfiguration.refreshInterval,
          state,
          fetcher: fetcher as RulesFetcher,
          cache: cache as ConfigurationCache,
          keyStore,
        });
  return controller;
}

/** Child records are attributed to the main process: drop renderer-style view fields. */
function withoutViewAttribution(record: EvaluationRecord): EvaluationRecord {
  if (record.viewId === undefined && record.viewUrl === undefined) {
    return record;
  }
  const attributed = { ...record };
  delete attributed.viewId;
  delete attributed.viewUrl;
  return attributed;
}

/** Whether two normalized contexts are equal (flat primitives, so JSON equality works). */
function contextEquals(a: FlatContext | undefined, b: FlatContext): boolean {
  return a !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Build the session exclusion check for `featureFlags.excludedPartitions` (P1). The
 * check runs when a renderer talks to main, and compares session identity:
 * `session.fromPartition` returns the one session of a partition, whether it was created
 * before or after init, so custom partitions are covered.
 */
export function createSessionExclusion(
  excludedPartitions: string[]
): (sender: Electron.WebContents | undefined) => boolean {
  if (excludedPartitions.length === 0) {
    return () => false;
  }
  return (sender) => {
    if (sender === undefined || sender === null) {
      return false;
    }
    const senderSession = sender.session;
    return excludedPartitions.some((partition) => electronSession.fromPartition(partition) === senderSession);
  };
}

/** Internal: the active controller, if feature flags were started. */
export function getFeatureFlagsController(): FeatureFlagsController | undefined {
  return getControllerHolder().controller;
}

/** Internal: register a provider constructed by the application. */
export function registerFlagsProvider(provider: ElectronMainFlagsProviderLike): void {
  const holder = getProviderHolder();
  if (holder.provider !== undefined) {
    display.warn('A Datadog feature flags provider was already registered; the last context written wins.');
  }
  holder.provider = provider;
  const controller = getControllerHolder().controller;
  if (controller !== undefined) {
    provider.onControllerStart(controller);
  }
}

/** Internal: unregister a provider (used by tests). */
export function unregisterFlagsProvider(): void {
  getProviderHolder().provider = undefined;
}

export type { FlatContext, FlagsSnapshot };
