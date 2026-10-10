import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk';
import * as fs from 'node:fs/promises';
import { display } from '../../tools/display';
import { EventKind, EventManager, EventTrack, type ServerEvent } from '../../event';
import { createFormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { CASES, oracle, fixtureWire } from '../../common/flags/evaluationCases.specUtil';
import { ElectronMainFlagsProvider } from './ElectronMainFlagsProvider';
import { getFeatureFlagsController, startFeatureFlags, unregisterFlagsProvider } from './startFeatureFlags';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/userData') },
}));

vi.mock('node:fs/promises');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);

const rulesJSON = JSON.parse(fixtureWire) as { rules: { response: string } };
const rulesBinary = Uint8Array.from(atob(rulesJSON.rules.response), (c) => c.charCodeAt(0));
const okResponse = () =>
  new Response(rulesBinary.buffer.slice(0), {
    status: 200,
    headers: { 'content-type': 'application/protobuf' },
  });

function flagsConfiguration(overrides: Record<string, unknown> = {}) {
  return createTestConfiguration({
    featureFlags: {
      env: 'e2e',
      refreshInterval: 0,
      fetchTimeout: 500,
      persistConfiguration: false,
      enableExposureLogging: true,
      enableRumFeatureFlagTracking: true,
      ...overrides,
    },
  });
}

describe('ElectronMainFlagsProvider', () => {
  let eventManager: EventManager;
  let requestViewUpdate: () => void;
  let serverEvents: ServerEvent[];
  let fetchHandler: () => Promise<Response>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    readFile.mockImplementation((path: unknown) => {
      if (String(path).endsWith('_dd_flags_anonymous_key')) {
        return Promise.resolve('123e4567-e89b-12d3-a456-426614174000');
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

  afterEach(() => {
    void getFeatureFlagsController()?.stop();
    unregisterFlagsProvider();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function startFlags(overrides: Record<string, unknown> = {}) {
    const hooks = createFormatHooks();
    return startFeatureFlags(flagsConfiguration(overrides), {
      eventManager,
      hooks,
      mainViewEmitter: { findViewId: () => 'view-1', requestViewUpdate },
      fetch: (..._args: unknown[]) => fetchHandler(),
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
    const owner = await startFlags({ refreshInterval: 1000 });
    const provider = new ElectronMainFlagsProvider();
    await OpenFeature.setProviderAndWait(provider);
    const changed: string[] = [];
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, () => changed.push('ConfigurationChanged'));
    await vi.advanceTimersByTimeAsync(1000);
    expect(changed.length).toBeGreaterThan(0);
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
});
