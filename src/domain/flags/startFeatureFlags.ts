import { app, session as electronSession } from 'electron';
import type { EventManager } from '../../event';
import { display } from '../../tools/display';
import { callMonitored } from '../telemetry';
import type { Configuration } from '../../config';
import type { FormatHooks } from '../../assembly';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import type { EvaluationRecord, FlagsSnapshot, FlagsTracking, FlatContext } from '../../common/flags/types';
import { AnonymousKeyStore } from './AnonymousKeyStore';
import { ConfigurationCache } from './ConfigurationCache';
import { ExposureCollector } from './ExposureCollector';
import { FeatureFlagsRumContext } from './FeatureFlagsRumContext';
import { SnapshotPublisher } from './SnapshotPublisher';
import { getFlagsHolder } from '../../common/flags/flagsHolder';
import { EvaluationRecordReceiver } from './EvaluationRecordReceiver';
import { isAllowedRendererFrame } from '../../assembly';
import { FlagsOwner } from './FlagsOwner';
import { FlagsState } from './FlagsState';
import { RulesFetcher, MAX_CONFIGURATION_LENGTH } from './RulesFetcher';

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
  /** Fan a main-process evaluation out to every enabled sink (exposures, main RUM). */
  recordEvaluation: (record: EvaluationRecord) => void;
  /** Resolves once the in-flight configuration fetch has been applied. */
  settled: () => Promise<void>;
  stop: () => Promise<void>;
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
 * the main RUM flag context, the snapshot publisher and the
 * renderer record receiver, and links any provider the application already constructed.
 * The owner starts last: the cached configuration is served (STALE) to every linked
 * component before the first network fetch, which is never awaited (B12). Returns the
 * controller, or `undefined` when flags are disabled.
 */
export async function startFeatureFlags(
  configuration: Configuration,
  deps: {
    eventManager: EventManager;
    hooks: FormatHooks;
    mainViewEmitter: {
      findViewId: (atTime: import('@datadog/js-core/time').TimeStamp) => string | undefined;
      requestViewUpdate: () => void;
    };
    /** Test seam: overrides the fetch implementation used for rules requests. */
    fetch?: typeof globalThis.fetch;
  }
): Promise<FeatureFlagsController | undefined> {
  const flagsConfiguration = configuration.featureFlags;
  if (flagsConfiguration === undefined) {
    return undefined;
  }
  const userDataPath = app.getPath('userData');
  const keyStore = await AnonymousKeyStore.init(userDataPath);
  const tracking: FlagsTracking = {
    exposures: flagsConfiguration.enableExposureLogging,
    rum: flagsConfiguration.enableRumFeatureFlagTracking,
    // Evaluation metrics are not sent yet.
    evaluations: false,
  };
  const env = flagsConfiguration.env ?? '';
  const flaggingProxy =
    flagsConfiguration.flaggingProxy !== undefined ? { flaggingProxy: flagsConfiguration.flaggingProxy } : {};
  const fetcher = new RulesFetcher({
    clientToken: configuration.clientToken,
    site: configuration.site,
    env,
    ...flaggingProxy,
    fetchTimeout: flagsConfiguration.fetchTimeout,
    maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  });
  // Disk only: the network is never awaited before the subsystem is linked (B12).
  const cache = await ConfigurationCache.init({
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
  evaluator.apply(state.snapshot());

  const collector = new ExposureCollector(
    state,
    { applicationId: configuration.applicationId, service: configuration.service },
    (event) => {
      deps.eventManager.notify(event);
    }
  );
  const rumContext = new FeatureFlagsRumContext({
    hooks: deps.hooks,
    findViewId: deps.mainViewEmitter.findViewId,
    requestViewUpdate: deps.mainViewEmitter.requestViewUpdate,
    enabled: () => tracking.rum,
  });
  /**
   * The shared tracking fan-out (B9): main and renderer records reach the same sinks.
   * Exposures and metrics take every record (the collector applies the upstream skip
   * rules, metrics count defaults and errors too); main RUM correlation only takes main
   * records with a variant, since renderers report to their own `DD_RUM`. Each sink is
   * isolated so a throwing sink is reported and never starves the others.
   */
  const fanOut = (record: EvaluationRecord, source: 'main' | 'renderer') => {
    if (tracking.exposures) {
      callMonitored(() => collector.add(record));
    }
    if (source === 'main' && tracking.rum && record.variant !== undefined && record.errorCode === undefined) {
      callMonitored(() => rumContext.record(record.flagKey, record.variant!, record.timestamp));
    }
  };

  const isSenderExcluded = createSessionExclusion(flagsConfiguration.excludedPartitions);
  getFlagsHolder().isSenderExcluded = isSenderExcluded;
  const publisher = new SnapshotPublisher(state, configuration.allowedRendererHosts, isSenderExcluded);
  publisher.start();
  const recordReceiver = new EvaluationRecordReceiver({
    onRecord: (record) => fanOut(record, 'renderer'),
    isAllowedSender: (frame, sender) =>
      !isSenderExcluded(sender) && isAllowedRendererFrame(frame, configuration.allowedRendererHosts),
  });
  recordReceiver.start();

  const controller: FeatureFlagsController = {
    state,
    keyStore,
    evaluator,
    tracking,
    fetchTimeout: flagsConfiguration.fetchTimeout,
    recordEvaluation: (record) => fanOut(record, 'main'),
    settled: () => owner.settled(),
    stop: async () => {
      if (getControllerHolder().controller === controller) {
        getControllerHolder().controller = undefined;
      }
      recordReceiver.stop();
      publisher.stop();
      if (getFlagsHolder().isSenderExcluded === isSenderExcluded) {
        getFlagsHolder().isSenderExcluded = undefined;
      }
      await owner.stop();
      collector.stop();
      rumContext.stop();
      evaluatorSubscription.unsubscribe();
      evaluator.stop();
    },
  };
  getControllerHolder().controller = controller;

  // Link a provider constructed before init(): its context is applied now.
  const pendingProvider = getProviderHolder().provider;
  if (pendingProvider !== undefined) {
    pendingProvider.onControllerStart(controller);
  }

  // Everything is linked: serving the cache (STALE) now reaches the evaluator, the
  // publisher and the provider, then the first network fetch runs in the background.
  const owner = FlagsOwner.start({
    refreshInterval: flagsConfiguration.refreshInterval,
    state,
    fetcher,
    cache,
    keyStore,
  });
  return controller;
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
