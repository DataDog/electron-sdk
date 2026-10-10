import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OpenFeature, ProviderEvents } from '@openfeature/web-sdk';
import { display } from '../../tools/display';
import { ElectronRendererFlagsProvider, FLUSH_INTERVAL, MAX_BATCH_BYTES } from './ElectronRendererFlagsProvider';
import { CASES, oracle, fixtureSnapshot, proContext } from '../../common/flags/evaluationCases.specUtil';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import { parseEvaluationBatch } from '../../common/flags/flagsPayloads';
import type { EvaluationBatch, FlagsSnapshot } from '../../common/flags/types';

interface PageGlobals {
  DatadogFlagsBridge?: unknown;
  DD_RUM?: unknown;
  location?: unknown;
}
const page = globalThis as unknown as PageGlobals;

function installBridge(initial: FlagsSnapshot | null | Promise<string> = fixtureSnapshot()) {
  const listeners = new Set<(snapshot: string) => void>();
  const sent: EvaluationBatch[] = [];
  const rawSent: string[] = [];
  const bridge = {
    getSnapshot: vi.fn(() =>
      initial instanceof Promise ? initial : Promise.resolve(initial === null ? undefined : JSON.stringify(initial))
    ),
    subscribe: vi.fn((callback: (snapshot: string) => void) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    }),
    sendEvaluations: vi.fn((json: string) => {
      rawSent.push(json);
      sent.push(JSON.parse(json) as EvaluationBatch);
    }),
  };
  page.DatadogFlagsBridge = bridge;
  return {
    bridge,
    sent,
    rawSent,
    listeners,
    push: (snapshot: FlagsSnapshot) => listeners.forEach((listener) => listener(JSON.stringify(snapshot))),
    records: () => sent.flatMap((batch) => batch.records),
  };
}

async function register(provider: ElectronRendererFlagsProvider) {
  await OpenFeature.setProviderAndWait(provider);
  return OpenFeature.getClient();
}

describe('ElectronRendererFlagsProvider', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    delete page.DatadogFlagsBridge;
    delete page.DD_RUM;
    page.location = { href: 'app://window/index.html' };
  });

  afterEach(async () => {
    await OpenFeature.clearProviders();
    vi.useRealTimers();
    vi.restoreAllMocks();
    delete page.location;
  });

  it.each(['READY', 'STALE'] as const)('initialize resolves on a %s snapshot', async (status) => {
    installBridge(fixtureSnapshot({ status }));
    const client = await register(new ElectronRendererFlagsProvider());
    expect(client.providerStatus).toBe('READY');
  });

  it('waits for a later snapshot when NOT_READY and rejects with PROVIDER_NOT_READY after initTimeout', async () => {
    const fake = installBridge(fixtureSnapshot({ status: 'NOT_READY', configuration: undefined, revision: 0 }));
    const settled = OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider({ initTimeout: 300 })).then(
      () => 'resolved',
      (error: { code?: string }) => error.code
    );
    await vi.advanceTimersByTimeAsync(299);
    fake.push(fixtureSnapshot({ status: 'NOT_READY', configuration: undefined, revision: 2 }));
    await vi.advanceTimersByTimeAsync(1);
    expect(await settled).toBe('PROVIDER_NOT_READY');
  });

  it('resolves a pending initialize when a READY snapshot arrives before initTimeout', async () => {
    const fake = installBridge(fixtureSnapshot({ status: 'NOT_READY', configuration: undefined, revision: 0 }));
    const registration = OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider({ initTimeout: 300 }));
    await vi.advanceTimersByTimeAsync(100);
    fake.push(fixtureSnapshot({ revision: 3 }));
    await expect(registration).resolves.toBeUndefined();
  });

  it.each([
    ['a rejected initialize', fixtureSnapshot({ status: 'NOT_READY', configuration: undefined, revision: 0 })],
    ['an ERROR snapshot', fixtureSnapshot({ status: 'ERROR', configuration: undefined, revision: 1 })],
  ])('emits Ready after a later READY snapshot following %s', async (_label, initial) => {
    const fake = installBridge(initial);
    const registration = OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider({ initTimeout: 200 })).catch(
      () => undefined
    );
    await vi.advanceTimersByTimeAsync(200);
    await registration;
    const client = OpenFeature.getClient();
    expect(client.providerStatus).toBe('ERROR');
    const ready: string[] = [];
    OpenFeature.addHandler(ProviderEvents.Ready, () => ready.push('Ready'));
    fake.push(fixtureSnapshot({ revision: 5 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toEqual(['Ready']);
    expect(client.providerStatus).toBe('READY');
  });

  it('rejects initialize at once on a DISABLED snapshot', async () => {
    installBridge(fixtureSnapshot({ status: 'DISABLED', configuration: undefined, context: undefined, revision: 0 }));
    const provider = new ElectronRendererFlagsProvider();
    await vi.advanceTimersByTimeAsync(0);
    await expect(provider.initialize()).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' });
  });

  it('emits ConfigurationChanged on a newer snapshot and ignores an older one', async () => {
    const fake = installBridge(fixtureSnapshot({ revision: 4 }));
    await register(new ElectronRendererFlagsProvider());
    const changed: string[] = [];
    OpenFeature.addHandler(ProviderEvents.ConfigurationChanged, () => changed.push('changed'));
    fake.push(fixtureSnapshot({ revision: 3, configurationRevision: 9, status: 'ERROR', configuration: undefined }));
    fake.push(fixtureSnapshot({ revision: 6, configurationRevision: 2 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(changed).toEqual(['changed']);
    expect(OpenFeature.getClient().getStringValue('targeted-flag', 'default')).not.toBe('default');
  });

  it('onContextChange warns once and keeps the snapshot context', async () => {
    installBridge(fixtureSnapshot({ context: proContext }));
    const client = await register(new ElectronRendererFlagsProvider());
    await OpenFeature.setContext({ targetingKey: 'renderer-user', plan: 'free' });
    await OpenFeature.setContext({ targetingKey: 'renderer-user-2', plan: 'free' });
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(client.getStringValue('targeted-flag', 'app-default')).toBe(
      oracle({ ...CASES[0], context: proContext }).value
    );
  });

  it('returns defaults, warns once and never throws when the bridge is absent', async () => {
    const provider = new ElectronRendererFlagsProvider();
    await expect(OpenFeature.setProviderAndWait(provider)).rejects.toMatchObject({ code: 'PROVIDER_NOT_READY' });
    const details = OpenFeature.getClient().getBooleanDetails('any-flag', true);
    expect(details.value).toBe(true);
    expect(details.errorCode).toBe('PROVIDER_NOT_READY');
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('stays not ready, without errors, when the snapshot channel gives no answer (excluded session)', async () => {
    const fake = installBridge(null);
    const provider = new ElectronRendererFlagsProvider({ initTimeout: 100 });
    await vi.advanceTimersByTimeAsync(0);
    const initialized = provider.initialize().then(
      () => 'resolved',
      (error: { code?: string }) => error.code
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await initialized).toBe('PROVIDER_NOT_READY');
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    expect(fake.sent).toEqual([]);
  });

  it('reports a getSnapshot rejection in the next batch instead of an unhandled rejection', async () => {
    const fake = installBridge(Promise.reject(new Error('invoke failed')));
    new ElectronRendererFlagsProvider();
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    expect(fake.sent).toEqual([{ records: [], errors: [expect.objectContaining({ message: 'invoke failed' })] }]);
  });

  for (const evaluationCase of CASES) {
    it(`parity › ${evaluationCase.name}`, async () => {
      installBridge(fixtureSnapshot({ context: evaluationCase.context }));
      const client = await register(new ElectronRendererFlagsProvider());
      const expected = oracle(evaluationCase);
      const details =
        evaluationCase.type === 'boolean'
          ? client.getBooleanDetails(evaluationCase.flagKey, evaluationCase.defaultValue as boolean)
          : evaluationCase.type === 'string'
            ? client.getStringDetails(evaluationCase.flagKey, evaluationCase.defaultValue as string)
            : evaluationCase.type === 'number'
              ? client.getNumberDetails(evaluationCase.flagKey, evaluationCase.defaultValue as number)
              : client.getObjectDetails(evaluationCase.flagKey, evaluationCase.defaultValue);
      expect([details.value, details.variant, details.reason, details.errorCode]).toEqual([
        expected.value,
        expected.variant,
        expected.reason,
        expected.errorCode,
      ]);
    });
  }

  describe('tracking', () => {
    it("sends records with contextRevision, viewId, viewUrl and the evaluator's configuration id, and no value or context", async () => {
      const fake = installBridge(fixtureSnapshot({ contextRevision: 7, context: proContext }));
      page.DD_RUM = {
        addFeatureFlagEvaluation: vi.fn(),
        getInternalContext: () => ({ view: { id: 'view-42', url: 'app://window/settings' } }),
      };
      const client = await register(new ElectronRendererFlagsProvider());
      const details = client.getStringDetails('targeted-flag', 'default');
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      const evaluator = new FlagsEvaluator();
      evaluator.apply(fixtureSnapshot({ context: proContext }));
      const configurationId = evaluator.resolve('string', 'targeted-flag', 'default').flagMetadata
        .__dd_core_configuration_id as string;
      expect(typeof configurationId).toBe('string');
      expect(fake.records()).toEqual([
        {
          flagKey: 'targeted-flag',
          variant: details.variant,
          allocationKey: details.flagMetadata.allocationKey,
          reason: details.reason,
          doLog: true,
          serialId: details.flagMetadata.__dd_split_serial_id,
          configurationId,
          contextRevision: 7,
          timestamp: expect.any(Number) as number,
          viewId: 'view-42',
          viewUrl: 'app://window/settings',
        },
      ]);
      expect(fake.rawSent.join('')).not.toContain('"value"');
      expect(fake.rawSent.join('')).not.toContain('"plan"');
      expect(parseEvaluationBatch(fake.rawSent[0], MAX_BATCH_BYTES)?.droppedCount).toBe(0);
    });

    it("a nested evaluation whose before hook throws does not take the outer evaluation's revision (R1)", async () => {
      const fake = installBridge(fixtureSnapshot({ revision: 1, contextRevision: 7, context: proContext }));
      const client = await register(new ElectronRendererFlagsProvider());
      let nested = false;
      client.addHooks({
        after: () => {
          if (nested) return;
          nested = true;
          fake.push(fixtureSnapshot({ revision: 2, contextRevision: 8, context: proContext }));
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
      expect(client.getStringValue('targeted-flag', 'default')).not.toBe('default');
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      const records = fake.records().map((record) => [record.errorCode ?? 'ok', record.contextRevision]);
      // The nested read failed in its before hook (never resolved); the outer resolved under revision 7.
      expect(records).toEqual([
        ['GENERAL', 8],
        ['ok', 7],
      ]);
    });

    it('flushes after 1000 ms or 50 records', async () => {
      const fake = installBridge();
      const client = await register(new ElectronRendererFlagsProvider());
      client.getStringValue('targeted-flag', 'default');
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL - 1);
      expect(fake.sent).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(fake.sent).toHaveLength(1);
      for (let index = 0; index < 50; index += 1) client.getStringValue('targeted-flag', 'default');
      expect(fake.sent).toHaveLength(2);
      expect(fake.sent[1].records).toHaveLength(50);
    });

    it('splits a flush into batches of at most 100 records and 64 KiB of JSON', async () => {
      const fake = installBridge();
      const provider = new ElectronRendererFlagsProvider();
      const client = await register(provider);
      const longKey = 'k'.repeat(250);
      client.getStringValue('targeted-flag', 'default');
      provider['records'] = Array.from({ length: 450 }, (_, index) => ({
        flagKey: `${longKey}-${index}`,
        reason: 'ERROR',
        errorCode: 'FLAG_NOT_FOUND',
        doLog: false,
        contextRevision: 1,
        timestamp: 1 as never,
        viewUrl: `app://window/${'u'.repeat(400)}`,
      }));
      await provider.onClose();
      expect(fake.records()).toHaveLength(450);
      expect(fake.records()[0].flagKey).toBe(`${longKey}-0`);
      for (const json of fake.rawSent) {
        expect(json.length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
        expect((JSON.parse(json) as EvaluationBatch).records.length).toBeLessThanOrEqual(100);
      }
      expect(fake.rawSent.length).toBeGreaterThan(4);
    });

    it('pre-dedupes identical exposure tuples within a revision only in exposure-only mode', async () => {
      const exposureOnly = installBridge(
        fixtureSnapshot({ tracking: { exposures: true, rum: false, evaluations: false } })
      );
      const client = await register(new ElectronRendererFlagsProvider());
      client.getStringValue('targeted-flag', 'default');
      client.getStringValue('targeted-flag', 'default');
      client.getBooleanValue('missing-flag', false); // not exposure-eligible: not sent
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      expect(exposureOnly.records().map((record) => record.flagKey)).toEqual(['targeted-flag']);
      await OpenFeature.clearProviders();

      const withMetrics = installBridge(
        fixtureSnapshot({ tracking: { exposures: true, rum: false, evaluations: true } })
      );
      const metricsClient = await register(new ElectronRendererFlagsProvider());
      metricsClient.getStringValue('targeted-flag', 'default');
      metricsClient.getStringValue('targeted-flag', 'default');
      metricsClient.getBooleanValue('missing-flag', false);
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      expect(withMetrics.records().map((record) => record.flagKey)).toEqual([
        'targeted-flag',
        'targeted-flag',
        'missing-flag',
      ]);
    });

    it('sends nothing when tracking.exposures and tracking.evaluations are both false', async () => {
      const fake = installBridge(fixtureSnapshot({ tracking: { exposures: false, rum: true, evaluations: false } }));
      const client = await register(new ElectronRendererFlagsProvider());
      client.getStringValue('targeted-flag', 'default');
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      expect(fake.sent).toEqual([]);
    });

    it('catches an invariant throw in the hook, reports at most 5 truncated errors, and keeps the returned value', async () => {
      const fake = installBridge();
      page.DD_RUM = {
        addFeatureFlagEvaluation: () => {
          const error = new Error('x'.repeat(2000));
          error.stack = 's'.repeat(2000);
          throw error;
        },
      };
      const client = await register(new ElectronRendererFlagsProvider());
      const values = Array.from({ length: 7 }, () => client.getStringValue('targeted-flag', 'default'));
      expect(new Set(values)).toEqual(new Set([oracle(CASES[0]).value]));
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      const errors = fake.sent.flatMap((batch) => batch.errors ?? []);
      expect(errors).toHaveLength(5);
      for (const error of errors) {
        expect(error.message).toHaveLength(1024);
        expect(error.stack).toHaveLength(1024);
      }
    });

    it('calls DD_RUM.addFeatureFlagEvaluation(flagKey, variant) for eligible evaluations when tracking.rum is true', async () => {
      installBridge();
      const addFeatureFlagEvaluation = vi.fn();
      page.DD_RUM = { addFeatureFlagEvaluation };
      const client = await register(new ElectronRendererFlagsProvider());
      const details = client.getStringDetails('targeted-flag', 'default');
      client.getBooleanValue('missing-flag', false);
      expect(addFeatureFlagEvaluation).toHaveBeenCalledTimes(1);
      expect(addFeatureFlagEvaluation).toHaveBeenCalledWith('targeted-flag', details.variant);
    });

    it('does not call DD_RUM when tracking.rum is false, and does nothing when DD_RUM is absent', async () => {
      installBridge(fixtureSnapshot({ tracking: { exposures: true, rum: false, evaluations: true } }));
      const addFeatureFlagEvaluation = vi.fn();
      page.DD_RUM = { addFeatureFlagEvaluation };
      const client = await register(new ElectronRendererFlagsProvider());
      client.getStringValue('targeted-flag', 'default');
      expect(addFeatureFlagEvaluation).not.toHaveBeenCalled();
      delete page.DD_RUM;
      expect(() => client.getStringValue('targeted-flag', 'default')).not.toThrow();
    });

    it('onClose flushes, clears the timer and releases the bridge subscription and the evaluator', async () => {
      const fake = installBridge();
      const provider = new ElectronRendererFlagsProvider();
      const client = await register(provider);
      client.getStringValue('targeted-flag', 'default');
      await OpenFeature.clearProviders();
      expect(fake.sent).toHaveLength(1);
      expect(fake.listeners.size).toBe(0);
      expect(provider.resolveStringEvaluation('targeted-flag', 'default').errorCode).toBe('PROVIDER_NOT_READY');
      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
