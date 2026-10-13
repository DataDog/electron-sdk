import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenFeature, OpenFeatureEventEmitter, ProviderEvents } from '@openfeature/web-sdk';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import { display } from '../../tools/display';
import { EventKind, EventManager, EventTrack, type ServerEvent } from '../../event';
import { createFormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { configurationToString } from '@datadog/openfeature-browser/rules-based';
import { CASES, oracle, fixtureWire, fixtureConfiguration } from '../../common/flags/evaluationCases.specUtil';
import {
  PRECOMPUTED_CASES,
  precomputedOracle,
  precomputedResponse,
  precomputedContext,
} from '../../common/flags/precomputedCases.specUtil';
import { ElectronMainFlagsProvider } from './ElectronMainFlagsProvider';
import { getFeatureFlagsController, startFeatureFlags, unregisterFlagsProvider } from './startFeatureFlags';
import { registerFlagsChannels } from '../../instrument/registerFlagsChannels';
import { MAIN_PROCESS_VIEW_URL } from './EvaluationAggregator';

const { ipcMain, frames, sessions } = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events');
  const emitter = new EventEmitter() as InstanceType<typeof EventEmitter> & {
    handlers: Map<string, (...args: unknown[]) => unknown>;
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  };
  emitter.handlers = new Map();
  emitter.handle = (channel, handler) => emitter.handlers.set(channel, handler);
  return { ipcMain: emitter, frames: new Map<string, unknown>(), sessions: new Map<string, object>() };
});

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/userData') },
  ipcMain,
  webFrameMain: { fromId: (processId: number, routingId: number) => frames.get(`${processId}:${routingId}`) },
  webContents: { fromFrame: () => undefined },
  session: {
    // One session object per partition, created lazily like Electron's.
    fromPartition: (partition: string) => {
      if (!sessions.has(partition)) sessions.set(partition, { partition });
      return sessions.get(partition);
    },
  },
}));

vi.mock('node:fs/promises');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
const ANONYMOUS_KEY = '123e4567-e89b-12d3-a456-426614174000';
const OPENFEATURE_API_KEY = Symbol.for('@openfeature/web-sdk/api');

const rulesJSON = JSON.parse(fixtureWire) as { rules: { response: string } };
const rulesBinary = Uint8Array.from(atob(rulesJSON.rules.response), (c) => c.charCodeAt(0));
const secondBinary = (() => {
  // The pro allocation serves the fallback variation: a different configuration.
  const clone = structuredClone(fixtureConfiguration) as Parameters<typeof configurationToString>[0] & {
    rules: { response: { flags: Record<string, { allocations: { splits: { variationIndex: number }[] }[] }> } };
  };
  clone.rules.response.flags['targeted-flag'].allocations[0].splits[0].variationIndex = 1;
  const wire = JSON.parse(configurationToString(clone)) as { rules: { response: string } };
  return Uint8Array.from(atob(wire.rules.response), (c) => c.charCodeAt(0));
})();
const okResponse = (binary: Uint8Array = rulesBinary) =>
  new Response(binary.slice().buffer, {
    status: 200,
    headers: { 'content-type': 'application/protobuf' },
  });

function flagsConfiguration(overrides: Record<string, unknown> = {}) {
  return createTestConfiguration({
    featureFlags: {
      evaluationMode: 'rules',
      env: 'e2e',
      refreshInterval: 0,
      fetchTimeout: 500,
      persistConfiguration: false,
      enableExposureLogging: true,
      enableRumFeatureFlagTracking: true,
      enableFlagEvaluationTracking: true,
      excludedPartitions: [],
      ...overrides,
    },
  });
}

describe('ElectronMainFlagsProvider', () => {
  let eventManager: EventManager;
  let requestViewUpdate: () => void;
  let serverEvents: ServerEvent[];
  let fetchHandler: (url?: unknown, init?: unknown) => Promise<Response>;
  let cachedWire: string | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    cachedWire = undefined;
    frames.clear();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
    readFile.mockImplementation((path: unknown) => {
      if (String(path).endsWith('_dd_flags_anonymous_key')) {
        return Promise.resolve(ANONYMOUS_KEY);
      }
      if (String(path).includes('/_dd_flags/') && cachedWire !== undefined) {
        return Promise.resolve(JSON.stringify({ wire: cachedWire, fetchedAt: Date.now() - 1000 }));
      }
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    });
    writeFile.mockResolvedValue(undefined);
    serverEvents = [];
    requestViewUpdate = vi.fn(() => undefined);
    eventManager = new EventManager();
    eventManager.registerHandler<ServerEvent>({
      canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
      handle: (event) => serverEvents.push(event),
    });
  });

  afterEach(async () => {
    await getFeatureFlagsController()?.stop();
    unregisterFlagsProvider();
    // The web-sdk provider and context are process singletons: clear them so one test's
    // provider (and its in-flight fetch handler) never leaks into the next one.
    await OpenFeature.clearProviders();
    await OpenFeature.setContext({}).catch(() => undefined);
    ipcMain.removeAllListeners();
    ipcMain.handlers.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startFlags(overrides: Record<string, unknown> = {}) {
    const hooks = createFormatHooks();
    return startFeatureFlags(flagsConfiguration(overrides), {
      eventManager,
      hooks,
      mainViewEmitter: { findViewId: () => 'view-1', requestViewUpdate },
      fetch: (...args: unknown[]) => fetchHandler(...args),
    });
  }

  it('initialize resolves when the owner is READY', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider);
  });

  it('initialize rejects with ProviderNotReadyError after fetchTimeout with no configuration', async () => {
    fetchHandler = () =>
      Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    await startFlags({ fetchTimeout: 500 });
    const provider = new ElectronMainFlagsProvider();
    const registration = OpenFeature.setProviderAndWait(provider);
    const assertion = registration.then(
      () => {
        throw new Error('expected rejection');
      },
      (error: Error & { code?: string }) => expect(error.code).toBe('PROVIDER_NOT_READY')
    );
    await vi.advanceTimersByTimeAsync(600);
    await assertion;
  });

  it('emits Ready after a later successful fetch following a rejected initialize', async () => {
    fetchHandler = () =>
      Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
    const ownerPromise = startFlags({ refreshInterval: 1000, fetchTimeout: 500 });
    const owner = (await ownerPromise)!;
    const provider = new ElectronMainFlagsProvider();
    const registration = OpenFeature.setProviderAndWait(provider);
    const rejection = registration.then(
      () => undefined,
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(600);
    await rejection;
    const readyEvents: string[] = [];
    OpenFeature.addHandler(ProviderEvents.Ready, () => readyEvents.push('Ready'));
    fetchHandler = () => Promise.resolve(okResponse());
    await vi.advanceTimersByTimeAsync(1000);
    expect(readyEvents).toContain('Ready');
    void owner.stop();
  });

  it('emits ConfigurationChanged on refresh', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const owner = await startFlags({ refreshInterval: 60000 });
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider);
    const changed: string[] = [];
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, () => changed.push('ConfigurationChanged'));
    fetchHandler = () => Promise.resolve(okResponse(secondBinary));
    await vi.advanceTimersByTimeAsync(60000);
    expect(changed).toEqual(['ConfigurationChanged']);
    void owner!.stop();
  });

  it('onContextChange replaces the owner context; logout to {} falls back to the anonymous key', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const owner = (await startFlags())!;
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider);
    await OpenFeature.setContext({ targetingKey: 'user-1', plan: 'pro' });
    expect(owner.state.snapshot().context).toEqual({ targetingKey: 'user-1', plan: 'pro' });
    await OpenFeature.setContext({});
    const anonymous = owner.state.snapshot().context;
    expect(anonymous!.targetingKey).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(Object.keys(anonymous ?? {})).toEqual(['targetingKey']);
    void owner.stop();
  });

  it('a context set before init() is applied when the owner starts', async () => {
    const provider = new ElectronMainFlagsProvider();
    await provider.onContextChange(undefined, { targetingKey: 'early-user' });
    fetchHandler = () => Promise.resolve(okResponse());
    const owner = (await startFlags())!;
    expect(owner.state.snapshot().context).toEqual({ targetingKey: 'early-user' });
    void owner.stop();
  });

  it('returns defaults and does not throw when init() was never called', () => {
    const provider = new ElectronMainFlagsProvider();
    const details = provider.resolveBooleanEvaluation('any-flag', true);
    expect(details.value).toBe(true);
    expect(details.errorCode).toBe('PROVIDER_NOT_READY');
    expect(display.warn).toHaveBeenCalled();
  });

  it('a second instance warns', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    new ElectronMainFlagsProvider();
    expect(display.warn).not.toHaveBeenCalled();
    new ElectronMainFlagsProvider();
    expect(display.warn).toHaveBeenCalled();
  });

  describe('precomputed mode (M7)', () => {
    const okPrecomputed = (targetingKey: string) =>
      new Response(JSON.stringify(precomputedResponseFor(targetingKey)), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      });
    const errorPrecomputed = (status: number) =>
      new Response(JSON.stringify({ errors: [{ detail: 'unavailable' }] }), {
        status,
        headers: { 'content-type': 'application/vnd.api+json' },
      });

    it('initialize resolves on READY and setContext waits for the new assignments', async () => {
      fetchHandler = () => Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      expect(owner.state.snapshot()).toMatchObject({ status: 'READY' });

      fetchHandler = () => Promise.resolve(okPrecomputed('user-pro'));
      const events: string[] = [];
      OpenFeature.addHandler(ProviderEvents.Reconciling, () => events.push('Reconciling'));
      OpenFeature.addHandler(ProviderEvents.ContextChanged, () => events.push('ContextChanged'));
      await OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'pro' });
      expect(events).toEqual(['Reconciling', 'ContextChanged']);
      expect(owner.state.snapshot()).toMatchObject({
        status: 'READY',
        context: { targetingKey: 'user-pro', plan: 'pro' },
      });
      void owner.stop();
    });

    it('serves defaults while assignments for a changed targeting key are fetched (Q2)', async () => {
      fetchHandler = () => Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      const client = OpenFeature.getClient();
      expect(client.getStringValue('assigned-flag', 'app-default')).toBe(`variant-${ANONYMOUS_KEY}`);

      let resolveFetch: (response: Response) => void = () => undefined;
      fetchHandler = () => new Promise<Response>((resolve) => (resolveFetch = resolve));
      const applied = OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'pro' });
      // Let the context-change handler start: while the assignments for the new identity
      // are in flight, the caller default is served (Q2).
      await vi.advanceTimersByTimeAsync(0);
      expect(client.getStringValue('assigned-flag', 'app-default')).toBe('app-default');
      resolveFetch(okPrecomputed('user-pro'));
      await applied;
      expect(client.getStringValue('assigned-flag', 'app-default')).toBe('variant-user-pro');
      void owner.stop();
    });

    it('a failing context fetch rejects and emits Error; a later success emits Ready', async () => {
      fetchHandler = () => Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      const owner = (await startFlags({ evaluationMode: 'precomputed', refreshInterval: 1000 }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      const errors: string[] = [];
      OpenFeature.addHandler(ProviderEvents.Error, () => errors.push('Error'));
      fetchHandler = () => Promise.resolve(errorPrecomputed(503));
      await OpenFeature.setContext({ targetingKey: 'user-stranger' });
      expect(errors).toEqual(['Error']);
      expect(owner.state.snapshot()).toMatchObject({ status: 'ERROR', configuration: undefined });

      const ready: string[] = [];
      OpenFeature.addHandler(ProviderEvents.Ready, () => ready.push('Ready'));
      fetchHandler = () => Promise.resolve(okPrecomputed('user-stranger'));
      await OpenFeature.setContext({ targetingKey: 'user-stranger', plan: 'pro' });
      expect(ready).toEqual(['Ready']);
      expect(owner.state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'user-stranger' } });
      void owner.stop();
    });

    it('concurrent setContext calls settle with the last one', async () => {
      fetchHandler = () => Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      fetchHandler = () => Promise.resolve(okPrecomputed('user-pro'));
      const first = OpenFeature.setContext({ targetingKey: 'user-a' }).catch(() => undefined);
      fetchHandler = () => Promise.resolve(okPrecomputed('user-b'));
      const second = OpenFeature.setContext({ targetingKey: 'user-b' }).catch(() => undefined);
      await Promise.all([first, second]);
      expect(owner.state.snapshot().context).toEqual({ targetingKey: 'user-b' });
      void owner.stop();
    });

    it('a failing fetch for the registration context leaves no unhandled rejection and keeps readiness bounded', async () => {
      fetchHandler = (_url?: unknown, init?: unknown) => {
        const targetingKey = targetingKeyOfRequest(init as RequestInit | undefined) ?? '';
        return Promise.resolve(targetingKey === ANONYMOUS_KEY ? okPrecomputed(ANONYMOUS_KEY) : errorPrecomputed(503));
      };
      const owner = (await startFlags({ evaluationMode: 'precomputed', fetchTimeout: 500 }))!;
      const unhandled: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandledRejection);
      try {
        // initialize() applies the registration context in the background (it is not the
        // promise initialize returns): its assignments fetch fails, so that background
        // promise rejects with nobody awaiting it.
        const provider = new ElectronMainFlagsProvider();
        const registration = OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-stranger' });
        const outcome = registration.then(
          () => 'resolved',
          (error: Error & { code?: string }) => error.code
        );
        await vi.advanceTimersByTimeAsync(600);
        // Readiness stays bounded: the registration rejects after fetchTimeout, not never.
        expect(await outcome).toBe('PROVIDER_NOT_READY');
        expect(owner.state.snapshot()).toMatchObject({ status: 'ERROR', context: { targetingKey: 'user-stranger' } });
        // The discarded context-application promise produced no unhandled rejection.
        expect(unhandled).toEqual([]);
      } finally {
        process.off('unhandledRejection', onUnhandledRejection);
      }
      void owner.stop();
    });

    it('a duplicate context change awaits the matching in-flight assignments fetch', async () => {
      fetchHandler = () => Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      const requestedKeys: string[] = [];
      const pendingFetches: ((response: Response) => void)[] = [];
      fetchHandler = (_url?: unknown, init?: unknown) => {
        requestedKeys.push(targetingKeyOfRequest(init as RequestInit | undefined) ?? '');
        return new Promise<Response>((resolve) => pendingFetches.push(resolve));
      };
      const first = OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'pro' });
      await vi.advanceTimersByTimeAsync(0);
      let secondSettled = false;
      const second = OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'pro' }).then(() => {
        secondSettled = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      // The duplicate did not settle before the assignments arrived, and it did not
      // supersede the matching in-flight fetch with a second network request.
      expect(secondSettled).toBe(false);
      expect(requestedKeys).toEqual(['user-pro']);
      pendingFetches[0](okPrecomputed('user-pro'));
      await Promise.all([first, second]);
      expect(owner.state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'user-pro' } });
      void owner.stop();
    });

    it('a reversion to the served context supersedes the pending one (pro → free → pro)', async () => {
      fetchHandler = (_url?: unknown, init?: unknown) => {
        const targetingKey = targetingKeyOfRequest(init as RequestInit | undefined) ?? '';
        return Promise.resolve(okPrecomputed(targetingKey));
      };
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
      expect(owner.state.snapshot()).toMatchObject({ status: 'READY' });
      const requestedPlans: string[] = [];
      const pendingFetches: ((response: Response) => void)[] = [];
      fetchHandler = (_url?: unknown, init?: unknown) => {
        requestedPlans.push(planOfRequest(init as RequestInit | undefined) ?? '');
        return new Promise<Response>((resolve) => pendingFetches.push(resolve));
      };
      // plan: free is requested (its fetch is pending), then the caller reverts to the
      // served plan: pro. The reversion must supersede the pending free fetch.
      const changeToFree = OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'free' });
      await vi.advanceTimersByTimeAsync(0);
      const revertToPro = OpenFeature.setContext({ targetingKey: 'user-pro', plan: 'pro' });
      await vi.advanceTimersByTimeAsync(0);
      expect(requestedPlans).toEqual(['free', 'pro']);
      // The reverted-to context's assignments arrive first and are applied.
      pendingFetches[1](okPrecomputed('user-pro'));
      await revertToPro;
      expect(owner.state.snapshot()).toMatchObject({
        status: 'READY',
        context: { targetingKey: 'user-pro', plan: 'pro' },
      });
      // The superseded free response arrives late: it must never be applied.
      pendingFetches[0](okPrecomputed('user-pro'));
      await changeToFree;
      await vi.advanceTimersByTimeAsync(0);
      expect(owner.state.snapshot()).toMatchObject({
        status: 'READY',
        context: { targetingKey: 'user-pro', plan: 'pro' },
      });
      void owner.stop();
    });

    it('a context set before init() is fetched for at startup', async () => {
      const provider = new ElectronMainFlagsProvider();
      await provider.onContextChange(undefined, { targetingKey: 'user-pro', plan: 'pro' });
      let requestedTargetingKey = '';
      fetchHandler = (_url?: unknown, init?: unknown) => {
        requestedTargetingKey = targetingKeyOfRequest(init as RequestInit | undefined) ?? '';
        return Promise.resolve(okPrecomputed('user-pro'));
      };
      const owner = (await startFlags({ evaluationMode: 'precomputed' }))!;
      await owner.settled();
      expect(requestedTargetingKey).toBe('user-pro');
      expect(owner.state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'user-pro' } });
      void owner.stop();
    });

    it('the precomputed request carries the client token, env and application id, and the context in the body', async () => {
      let seen: { url?: string; init?: RequestInit } = {};
      fetchHandler = (url?: unknown, init?: unknown) => {
        seen = { url: url as string, init: init as RequestInit };
        return Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
      };
      await startFlags({ evaluationMode: 'precomputed' });
      await getFeatureFlagsController()?.settled();
      expect(seen.init?.method).toBe('POST');
      expect(targetingKeyOfRequest(seen.init)).toBe(ANONYMOUS_KEY);
      // The upstream request stringifies the whole context into targeting_attributes
      // (including the targeting key), plus the dedicated targeting_key field.
      expect(targetingAttributesOfRequest(seen.init)).toEqual({ targetingKey: ANONYMOUS_KEY });
    });

    it('initialize rejects after fetchTimeout with no assignments', async () => {
      fetchHandler = () =>
        Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
      await startFlags({ evaluationMode: 'precomputed', fetchTimeout: 500 });
      const provider = new ElectronMainFlagsProvider();
      const registration = OpenFeature.setProviderAndWait(provider);
      const assertion = registration.then(
        () => {
          throw new Error('expected rejection');
        },
        (error: Error & { code?: string }) => expect(error.code).toBe('PROVIDER_NOT_READY')
      );
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
    });

    for (const evaluationCase of PRECOMPUTED_CASES) {
      it(`precomputed parity \u2039 ${evaluationCase.name}`, async () => {
        fetchHandler = () =>
          Promise.resolve(
            new Response(JSON.stringify(precomputedResponse), {
              status: 200,
              headers: { 'content-type': 'application/vnd.api+json' },
            })
          );
        await startFlags({ evaluationMode: 'precomputed' });
        const provider = new ElectronMainFlagsProvider();
        await OpenFeature.setProviderAndWait(provider, precomputedContext);
        const client = OpenFeature.getClient();
        const expected = precomputedOracle(evaluationCase);
        const details =
          evaluationCase.type === 'boolean'
            ? client.getBooleanDetails(evaluationCase.flagKey, evaluationCase.defaultValue as boolean)
            : evaluationCase.type === 'string'
              ? client.getStringDetails(evaluationCase.flagKey, evaluationCase.defaultValue as string)
              : evaluationCase.type === 'number'
                ? client.getNumberDetails(evaluationCase.flagKey, evaluationCase.defaultValue as number)
                : client.getObjectDetails(evaluationCase.flagKey, evaluationCase.defaultValue);
        expect({
          value: details.value,
          variant: details.variant,
          reason: details.reason,
          errorCode: details.errorCode,
        }).toEqual({
          value: expected.value,
          variant: expected.variant,
          reason: expected.reason,
          errorCode: expected.errorCode,
        });
      });
    }
  });

  for (const evaluationCase of CASES) {
    it(`parity › ${evaluationCase.name}`, async () => {
      fetchHandler = () => Promise.resolve(okResponse());
      await startFlags();
      const provider = new ElectronMainFlagsProvider();
      await OpenFeature.setProviderAndWait(provider);
      await OpenFeature.setContext(evaluationCase.context);
      const client = OpenFeature.getClient();
      const expected = oracle(evaluationCase);
      const details =
        evaluationCase.type === 'boolean'
          ? client.getBooleanDetails(evaluationCase.flagKey, evaluationCase.defaultValue as boolean)
          : evaluationCase.type === 'string'
            ? client.getStringDetails(evaluationCase.flagKey, evaluationCase.defaultValue as string)
            : evaluationCase.type === 'number'
              ? client.getNumberDetails(evaluationCase.flagKey, evaluationCase.defaultValue as number)
              : client.getObjectDetails(evaluationCase.flagKey, evaluationCase.defaultValue);
      expect({
        value: details.value,
        variant: details.variant,
        reason: details.reason,
        errorCode: details.errorCode,
      }).toEqual({
        value: expected.value,
        variant: expected.variant,
        reason: expected.reason,
        errorCode: expected.errorCode,
      });
    });
  }

  it('an eligible evaluation produces one exposure and one view update request', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const client = OpenFeature.getClient();
    client.getStringValue('targeted-flag', 'default');
    await vi.advanceTimersByTimeAsync(0);
    const exposures = serverEvents.filter((event) => event.track === EventTrack.EXPOSURES);
    expect(exposures).toHaveLength(1);
    expect(requestViewUpdate).toHaveBeenCalled();
  });

  it("a nested evaluation whose before hook throws does not take the outer evaluation's revision (R1)", async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const client = OpenFeature.getClient();
    let nested = false;
    client.addHooks({
      after: () => {
        if (nested) return;
        nested = true;
        void provider.onContextChange(undefined, { targetingKey: 'someone-else', plan: 'free' });
        // The same flag, read again from inside the hook; its own before hook throws.
        client.getStringValue('targeted-flag', 'default', {
          hooks: [
            {
              before: () => {
                throw new Error('nested before hook failure');
              },
            },
          ],
        });
      },
    });
    expect(client.getStringValue('targeted-flag', 'default')).toBe('variant-a');
    await vi.advanceTimersByTimeAsync(0);
    const exposures = serverEvents.filter((event) => event.track === EventTrack.EXPOSURES);
    expect(exposures.map((event) => (event.data as { subject: { id: string } }).subject.id)).toEqual(['user-pro']);
  });

  it('a throwing exposure sink leaves the RUM sink and the returned value unaffected (A3)', async () => {
    const { ExposureCollector } = await import('./ExposureCollector');
    const add = vi.spyOn(ExposureCollector.prototype, 'add').mockImplementation(() => {
      throw new Error('collector failure');
    });
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).toBe('variant-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(add).toHaveBeenCalled();
    expect(requestViewUpdate).toHaveBeenCalled();
    add.mockRestore();
  });

  it('a throwing RUM sink leaves the exposure sink and the returned value unaffected (A3)', async () => {
    const { FeatureFlagsRumContext } = await import('./FeatureFlagsRumContext');
    const record = vi.spyOn(FeatureFlagsRumContext.prototype, 'record').mockImplementation(() => {
      throw new Error('rum failure');
    });
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).toBe('variant-a');
    await vi.advanceTimersByTimeAsync(0);
    expect(record).toHaveBeenCalled();
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
    record.mockRestore();
  });

  it('evaluations with an errorCode produce no exposure and no RUM entry', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const client = OpenFeature.getClient();
    client.getBooleanValue('missing-flag', false);
    client.getBooleanValue('disabled-flag', false);
    await vi.advanceTimersByTimeAsync(0);
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(0);
    expect(requestViewUpdate).not.toHaveBeenCalled();
  });

  it('enableRumFeatureFlagTracking false disables only the RUM sink', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags({ enableRumFeatureFlagTracking: false });
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    OpenFeature.getClient().getStringValue('targeted-flag', 'default');
    await vi.advanceTimersByTimeAsync(0);
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
    expect(requestViewUpdate).not.toHaveBeenCalled();
  });
  it('links the evaluator, publisher and provider to the cache-backed STALE state before the first network fetch', async () => {
    registerFlagsChannels(ipcMain as unknown as Electron.IpcMain);
    cachedWire = fixtureWire;
    fetchHandler = () => new Promise<Response>(() => undefined); // held forever
    const controller = (await startFlags({ persistConfiguration: true }))!;
    expect(controller.state.snapshot().status).toBe('STALE');
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).toBe(
      oracle({ ...CASES[0], context: { targetingKey: 'user-pro', plan: 'pro' } }).value
    );
    const frame = makeFrame(1, 1);
    const snapshot = JSON.parse(ipcMain.handlers.get('datadog:flags-snapshot')!({ senderFrame: frame }) as string) as {
      status: string;
    };
    expect(snapshot.status).toBe('STALE');
  });

  it('pushes the current snapshot to frames that subscribed through the instrument handler before init', async () => {
    registerFlagsChannels(ipcMain as unknown as Electron.IpcMain);
    const frame = makeFrame(4, 2);
    const preInit = JSON.parse(ipcMain.handlers.get('datadog:flags-snapshot')!({ senderFrame: frame }) as string) as {
      status: string;
    };
    expect(preInit.status).toBe('NOT_READY');
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags())!;
    await controller.settled();
    const pushed = frame.send.mock.calls.map((call) => (JSON.parse(call[1] as string) as { status: string }).status);
    expect(pushed[0]).toBe('NOT_READY');
    expect(pushed).toContain('READY');
  });

  it('records the context revision used at resolution even when an after hook changes the context', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags({ enableFlagEvaluationTracking: false }))!;
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const usedRevision = controller.state.snapshot().contextRevision;
    const client = OpenFeature.getClient();
    client.addHooks({
      after: () => {
        void provider.onContextChange(undefined, { targetingKey: 'someone-else', plan: 'free' });
      },
    });
    client.getStringValue('targeted-flag', 'default');
    expect(controller.state.snapshot().contextRevision).toBeGreaterThan(usedRevision);
    const exposures = serverEvents.filter((event) => event.track === EventTrack.EXPOSURES);
    expect(exposures).toHaveLength(1);
    expect((exposures[0].data as { subject: { id: string } }).subject.id).toBe('user-pro');
  });

  it('a throwing metrics sink leaves the exposure sink and the returned value unaffected (A3)', async () => {
    const { EvaluationAggregator } = await import('./EvaluationAggregator');
    const add = vi.spyOn(EvaluationAggregator.prototype, 'add').mockImplementation(() => {
      throw new Error('aggregator failure');
    });
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).toBe('variant-a');
    expect(add).toHaveBeenCalled();
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
    add.mockRestore();
  });

  it('a throwing RUM sink still lets the metrics sink receive the evaluation (A3)', async () => {
    const { FeatureFlagsRumContext } = await import('./FeatureFlagsRumContext');
    const { EvaluationAggregator } = await import('./EvaluationAggregator');
    const record = vi.spyOn(FeatureFlagsRumContext.prototype, 'record').mockImplementation(() => {
      throw new Error('rum failure');
    });
    const add = vi.spyOn(EvaluationAggregator.prototype, 'add');
    fetchHandler = () => Promise.resolve(okResponse());
    await startFlags();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).toBe('variant-a');
    expect(record).toHaveBeenCalled();
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ flagKey: 'targeted-flag' }));
    record.mockRestore();
    add.mockRestore();
  });

  it('feeds exposures and evaluation metrics independently, including default and error evaluations', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags())!;
    expect(controller.tracking.evaluations).toBe(true);
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const client = OpenFeature.getClient();
    client.getStringValue('targeted-flag', 'default');
    client.getStringValue('targeted-flag', 'default');
    client.getBooleanValue('missing-flag', false);
    await controller.stop();
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
    const metrics = serverEvents
      .filter((event) => event.track === EventTrack.FLAGEVALUATION)
      .map((event) => event.data as { flag: { key: string }; evaluation_count: number; runtime_default_used: boolean });
    expect(metrics).toEqual([
      expect.objectContaining({ flag: { key: 'targeted-flag' }, evaluation_count: 2, runtime_default_used: false }),
      expect.objectContaining({ flag: { key: 'missing-flag' }, evaluation_count: 1, runtime_default_used: true }),
    ]);
  });

  it('routes renderer records through the shared fan-out to exposures and metrics, but not main RUM', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags())!;
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    const details = OpenFeature.getClient().getStringDetails('targeted-flag', 'default');
    await controller.stop();
    serverEvents.length = 0;
    vi.mocked(requestViewUpdate).mockClear();

    const restarted = (await startFlags())!;
    await restarted.settled();
    const record = {
      flagKey: 'targeted-flag',
      variant: details.variant,
      allocationKey: details.flagMetadata.allocationKey,
      reason: details.reason,
      doLog: true,
      contextRevision: 0,
      timestamp: 100,
      viewUrl: 'app://window/index.html',
    };
    ipcMain.emit(
      'datadog:flags-evaluations',
      { senderFrame: { origin: 'app://window', url: 'app://window/index.html' } },
      JSON.stringify({ records: [record] })
    );
    await restarted.stop();
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
    const metrics = serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION);
    expect(metrics).toHaveLength(1);
    expect(JSON.stringify(metrics[0].data)).toContain('app://window/index.html');
    expect(JSON.stringify(metrics[0].data)).not.toContain(MAIN_PROCESS_VIEW_URL);
    expect(requestViewUpdate).not.toHaveBeenCalled();
  });

  it('does not advertise evaluation tracking in snapshots when enableFlagEvaluationTracking is false', async () => {
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags({ enableFlagEvaluationTracking: false }))!;
    expect(controller.state.snapshot().tracking).toEqual({ exposures: true, rum: true, evaluations: false });
    await controller.stop();
    expect(serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION)).toHaveLength(0);
  });

  it.each([
    ['the first network fetch', false],
    ['the disk cache', true],
  ])(
    'recovers a provider whose initialize timed out before init(): Ready fires once init serves %s',
    async (_label, withCache) => {
      const provider = new ElectronMainFlagsProvider();
      const registration = OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' }).then(
        () => 'resolved',
        (error: { code?: string }) => error.code
      );
      await vi.advanceTimersByTimeAsync(6000);
      expect(await registration).toBe('PROVIDER_NOT_READY');
      const client = OpenFeature.getClient();
      expect(client.providerStatus).toBe('ERROR');
      const ready: string[] = [];
      OpenFeature.addHandler(ProviderEvents.Ready, () => ready.push('Ready'));

      cachedWire = withCache ? fixtureWire : undefined;
      fetchHandler = () => Promise.resolve(okResponse());
      const controller = (await startFlags({ persistConfiguration: withCache }))!;
      await controller.settled();
      await vi.advanceTimersByTimeAsync(0);

      expect(ready).toEqual(['Ready']);
      expect(client.providerStatus).toBe('READY');
      expect(client.getStringValue('targeted-flag', 'default')).toBe(
        oracle({ ...CASES[0], context: { targetingKey: 'user-pro', plan: 'pro' } }).value
      );
    }
  );

  it('excludes a persist: partition created after init: no bridge, no snapshot, no records accepted', async () => {
    registerFlagsChannels(ipcMain as unknown as Electron.IpcMain);
    fetchHandler = () => Promise.resolve(okResponse());
    const controller = (await startFlags({ excludedPartitions: ['persist:target'] }))!;
    await controller.settled();
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
    serverEvents.length = 0;

    // Sessions created after init, like Vitrine's persist:target.
    const excludedSender = Object.assign(new EventEmitter(), { id: 10, session: { partition: 'after-init' } });
    sessions.set('persist:target', excludedSender.session);
    const defaultSender = Object.assign(new EventEmitter(), { id: 11, session: {} });
    const bridgeEnabled = (sender: unknown) => {
      const event: { sender: unknown; returnValue?: unknown } = { sender };
      ipcMain.emit('datadog:flags-bridge-enabled', event);
      return event.returnValue;
    };
    expect(bridgeEnabled(excludedSender)).toBe(false);
    expect(bridgeEnabled(defaultSender)).toBe(true);

    const snapshotHandler = ipcMain.handlers.get('datadog:flags-snapshot')!;
    const frame = makeFrame(8, 1);
    expect(snapshotHandler({ senderFrame: frame, sender: excludedSender })).toBeUndefined();
    expect(JSON.parse(snapshotHandler({ senderFrame: frame, sender: defaultSender }) as string)).toMatchObject({
      status: 'READY',
    });

    const details = OpenFeature.getClient().getStringDetails('targeted-flag', 'default');
    await controller.stop();
    serverEvents.length = 0;
    const restarted = (await startFlags({ excludedPartitions: ['persist:target'] }))!;
    await restarted.settled();
    const batch = JSON.stringify({
      records: [
        {
          flagKey: 'targeted-flag',
          variant: details.variant,
          allocationKey: details.flagMetadata.allocationKey,
          reason: details.reason,
          doLog: true,
          contextRevision: 0,
          timestamp: 100,
        },
      ],
    });
    const senderFrame = { origin: 'app://window', url: 'app://window/index.html' };
    ipcMain.emit('datadog:flags-evaluations', { senderFrame, sender: excludedSender }, batch);
    await restarted.stop();
    expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(0);
  });

  it('works when registered with a separate copy of @openfeature/web-sdk (events, error .code, API singleton)', async () => {
    const savedApi = (globalThis as Record<symbol, unknown>)[OPENFEATURE_API_KEY];
    delete (globalThis as Record<symbol, unknown>)[OPENFEATURE_API_KEY];
    try {
      const copyA = loadSeparateWebSdkCopy();
      const copyB = loadSeparateWebSdkCopy();
      // Separate module copies, one shared API through the Symbol.for singleton.
      expect(copyA.OpenFeatureEventEmitter).not.toBe(OpenFeatureEventEmitter);
      expect(copyB.OpenFeatureEventEmitter).not.toBe(copyA.OpenFeatureEventEmitter);
      expect(copyB.OpenFeature).toBe(copyA.OpenFeature);
      expect(copyA.OpenFeature).not.toBe(OpenFeature);

      fetchHandler = () =>
        Promise.resolve(new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
      await startFlags({ refreshInterval: 60000, fetchTimeout: 500 });
      const provider = new ElectronMainFlagsProvider();
      const registration = copyA.OpenFeature.setProviderAndWait(provider, { targetingKey: 'user-pro', plan: 'pro' });
      const rejection = registration.then(
        () => 'resolved',
        (error: { code?: string }) => error.code
      );
      await vi.advanceTimersByTimeAsync(500);
      expect(await rejection).toBe('PROVIDER_NOT_READY');
      const client = copyB.OpenFeature.getClient();
      expect(client.getStringDetails('targeted-flag', 'default').errorCode).toBe('PROVIDER_NOT_READY');

      const ready: string[] = [];
      copyB.OpenFeature.addHandler(copyB.ProviderEvents.Ready, () => ready.push('Ready'));
      fetchHandler = () => Promise.resolve(okResponse());
      await vi.advanceTimersByTimeAsync(60000);
      expect(ready).toEqual(['Ready']);
      expect(client.getStringValue('targeted-flag', 'default')).toBe(
        oracle({ ...CASES[0], context: { targetingKey: 'user-pro', plan: 'pro' } }).value
      );
      await copyA.OpenFeature.clearProviders();
    } finally {
      (globalThis as Record<symbol, unknown>)[OPENFEATURE_API_KEY] = savedApi;
    }
  });
});

function makeFrame(processId: number, routingId: number) {
  const frame = {
    origin: 'app://window',
    url: 'app://window/index.html',
    processId,
    routingId,
    send: vi.fn(),
    isDestroyed: () => false,
  };
  frames.set(`${processId}:${routingId}`, frame);
  return frame;
}

/** Load a fresh CommonJS instance of @openfeature/web-sdk (and its core), like an app's own copy. */
function loadSeparateWebSdkCopy(): typeof import('@openfeature/web-sdk') {
  const requireFromHere = createRequire(import.meta.url);
  for (const id of ['@openfeature/web-sdk', '@openfeature/core']) {
    delete requireFromHere.cache[requireFromHere.resolve(id)];
  }
  return requireFromHere('@openfeature/web-sdk') as typeof import('@openfeature/web-sdk');
}

/** The assignments response body `/precompute-assignments` returns for a targeting key. */
function precomputedResponseFor(targetingKey: string): Record<string, unknown> {
  return {
    data: {
      attributes: {
        createdAt: `created-${targetingKey}`,
        flags: {
          'assigned-flag': {
            allocationKey: 'assign-a',
            variationKey: `variant-${targetingKey}`,
            variationType: 'string',
            variationValue: `variant-${targetingKey}`,
            reason: 'STATIC',
            doLog: true,
            serialId: 11,
          },
        },
      },
    },
  };
}

/** Read the `subject.targeting_key` of a precompute-assignments request body. */
function targetingKeyOfRequest(init: RequestInit | undefined): string | undefined {
  return init?.body !== undefined ? precomputedSubjectOf(init.body as string)?.targeting_key : undefined;
}

/** Read the `subject.targeting_attributes` of a precompute-assignments request body. */
function targetingAttributesOfRequest(init: RequestInit | undefined): Record<string, string | number | boolean> {
  return init?.body !== undefined ? (precomputedSubjectOf(init.body as string)?.targeting_attributes ?? {}) : {};
}

/** Read the `plan` attribute of a precompute-assignments request body. */
function planOfRequest(init: RequestInit | undefined): string | undefined {
  const plan = targetingAttributesOfRequest(init).plan;
  return typeof plan === 'string' ? plan : undefined;
}

function precomputedSubjectOf(
  body: string
): { targeting_key?: string; targeting_attributes?: Record<string, string | number | boolean> } | undefined {
  try {
    const parsed = JSON.parse(body) as {
      data?: {
        attributes?: {
          subject?: { targeting_key?: string; targeting_attributes?: Record<string, string | number | boolean> };
        };
      };
    };
    return parsed.data?.attributes?.subject;
  } catch {
    return undefined;
  }
}
