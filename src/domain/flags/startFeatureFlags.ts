import { app } from 'electron';
import type { EventManager } from '../../event';
import { display } from '../../tools/display';
import type { Configuration } from '../../config';
import type { FormatHooks } from '../../assembly';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import type { EvaluationRecord, FlagsSnapshot, FlagsTracking, FlatContext } from '../../common/flags/types';
import { AnonymousKeyStore } from './AnonymousKeyStore';
import { ConfigurationCache } from './ConfigurationCache';
import { ExposureCollector } from './ExposureCollector';
import { FeatureFlagsRumContext } from './FeatureFlagsRumContext';
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
  recordEvaluation: (record: EvaluationRecord) => void;
  stop: () => void | Promise<void>;
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
 * state, the anonymous key store, the fetcher, the disk cache, the owner, the exposure
 * collector and the main RUM flag context, and links any provider the application
 * already constructed. Returns the controller, or `undefined` when flags are disabled.
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
    evaluations: true,
  };
  const state = new FlagsState({ targetingKey: keyStore.anonymousKey }, tracking);
  const fetcher = new RulesFetcher({
    clientToken: configuration.clientToken,
    site: configuration.site,
    env: flagsConfiguration.env ?? '',
    ...(flagsConfiguration.flaggingProxy !== undefined ? { flaggingProxy: flagsConfiguration.flaggingProxy } : {}),
    fetchTimeout: flagsConfiguration.fetchTimeout,
    maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
    ...(deps.fetch !== undefined ? { fetch: deps.fetch } : {}),
  });
  const cache = await ConfigurationCache.init({
    userDataPath,
    site: configuration.site,
    env: flagsConfiguration.env ?? '',
    clientToken: configuration.clientToken,
    ...(flagsConfiguration.flaggingProxy !== undefined ? { flaggingProxy: flagsConfiguration.flaggingProxy } : {}),
    persistConfiguration: flagsConfiguration.persistConfiguration,
  });
  const owner = await FlagsOwner.start({
    refreshInterval: flagsConfiguration.refreshInterval,
    state,
    fetcher,
    cache,
    keyStore,
  });

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

  const evaluator = new FlagsEvaluator();
  state.subscribe((snapshot) => {
    evaluator.apply(snapshot);
  });
  evaluator.apply(state.snapshot());

  const controller: FeatureFlagsController = {
    state,
    keyStore,
    evaluator,
    tracking,
    fetchTimeout: flagsConfiguration.fetchTimeout,
    recordEvaluation: (record) => {
      if (tracking.exposures) {
        collector.add(record);
      }
      if (tracking.rum && record.variant !== undefined) {
        rumContext.record(record.flagKey, record.variant, record.timestamp);
      }
    },
    stop: async () => {
      await owner.stop();
      collector.stop();
      rumContext.stop();
      evaluator.stop();
      getControllerHolder().controller = undefined;
    },
  };
  getControllerHolder().controller = controller;

  // Link a provider constructed before init(): its context is applied now.
  const pendingProvider = getProviderHolder().provider;
  if (pendingProvider !== undefined) {
    pendingProvider.onControllerStart(controller);
  }
  return controller;
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
