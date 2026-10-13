import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { display } from '../../tools/display';
import {
  contextResponseMessage,
  decodeFrame,
  encodeFrame,
  isChildMessage,
  snapshotMessage,
  type ChildMessage,
} from '../../common/flags/childProtocol';
import { CASES, oracle, fixtureSnapshot, proContext } from '../../common/flags/evaluationCases.specUtil';
import {
  PRECOMPUTED_CASES,
  precomputedOracle,
  precomputedSnapshot,
} from '../../common/flags/precomputedCases.specUtil';
import { FlagsEvaluator } from '../../common/flags/FlagsEvaluator';
import { minimalFlagsSnapshot } from '../../common/flags/flagsHolder';
import type { FlagValue } from '@openfeature/web-sdk';
import type { EvaluationBatch, FlagsSnapshot } from '../../common/flags/types';
import { connectFlags, CONTEXT_REQUEST_TIMEOUT, type ChildFlagsClient } from './ChildFlagsClient';
import { FLUSH_INTERVAL, MAX_BATCH_BYTES } from '../../common/flags/EvaluationReporter';

/** A child connected over frames, with main simulated by the test. */
function connectOverFrames() {
  const toMain: ChildMessage[] = [];
  const client = connectFlags({ send: (frame) => toMain.push(decodeFrame(frame)!) });
  return {
    client,
    toMain,
    push: (snapshot: FlagsSnapshot) => client.receive(encodeFrame(snapshotMessage(JSON.stringify(snapshot)))),
    batches: () =>
      toMain
        .filter((message) => message.type === 'evaluations')
        .map((message) => JSON.parse((message as { payload: string }).payload) as EvaluationBatch),
    records: () =>
      toMain
        .filter((message) => message.type === 'evaluations')
        .flatMap((message) => (JSON.parse((message as { payload: string }).payload) as EvaluationBatch).records),
  };
}

function evaluate(client: ChildFlagsClient, type: string, flagKey: string, defaultValue: FlagValue) {
  switch (type) {
    case 'boolean':
      return client.getBooleanDetails(flagKey, defaultValue as boolean);
    case 'string':
      return client.getStringDetails(flagKey, defaultValue as string);
    case 'number':
      return client.getNumberDetails(flagKey, defaultValue as number);
    default:
      return client.getObjectDetails(flagKey, defaultValue);
  }
}

describe('ChildFlagsClient', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the caller default with PROVIDER_NOT_READY and status NOT_READY before the first snapshot', () => {
    const { client } = connectOverFrames();
    expect(client.status).toBe('NOT_READY');
    expect(client.getStringDetails('targeted-flag', 'default')).toMatchObject({
      value: 'default',
      errorCode: 'PROVIDER_NOT_READY',
    });
    expect(client.getBooleanValue('split-flag', true)).toBe(true);
  });

  it('sends hello on connect and applies the answered snapshot', () => {
    const { client, toMain, push } = connectOverFrames();
    expect(toMain).toEqual([{ __ddElectronSdkFlags: 1, type: 'hello' }]);
    push(fixtureSnapshot({ context: proContext }));
    expect(client.status).toBe('READY');
    expect(client.getStringValue('targeted-flag', 'default')).toBe(oracle(CASES[0]).value);
  });

  it('a pending-identity NOT_READY invalidation clears the held assignments', () => {
    const { client, push } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext }));
    expect(client.getStringValue('targeted-flag', 'default')).not.toBe('default');

    // Main is fetching assignments for a changed targeting key: the invalidation clears the
    // previous identity's assignments in the child too.
    push(
      fixtureSnapshot({
        revision: fixtureSnapshot({ revision: 5 }).revision,
        status: 'NOT_READY',
        configuration: undefined,
        context: { targetingKey: 'user-2' },
        contextRevision: 2,
      })
    );
    expect(client.status).toBe('NOT_READY');
    expect(client.getStringValue('targeted-flag', 'default')).toBe('default');
    expect(client.getStringDetails('targeted-flag', 'default').errorCode).toBe('PROVIDER_NOT_READY');
  });

  it('ignores an older revision; a minimal snapshot never overrides a real one', () => {
    const { client, push } = connectOverFrames();
    push(fixtureSnapshot({ revision: 5, status: 'STALE' }));
    push(fixtureSnapshot({ revision: 4, status: 'ERROR', configuration: undefined }));
    expect(client.status).toBe('STALE');
    push(minimalFlagsSnapshot('NOT_READY'));
    expect(client.status).toBe('STALE');
    expect(client.getStringValue('targeted-flag', 'default')).not.toBe('default');
  });

  for (const evaluationCase of CASES) {
    it(`parity › ${evaluationCase.name} (frames)`, () => {
      const { client, push } = connectOverFrames();
      push(fixtureSnapshot({ context: evaluationCase.context }));
      const details = evaluate(client, evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
      const expected = oracle(evaluationCase);
      expect([details.value, details.variant, details.reason, details.errorCode]).toEqual([
        expected.value,
        expected.variant,
        expected.reason,
        expected.errorCode,
      ]);
    });

    it(`parity › ${evaluationCase.name} (port)`, async () => {
      const { port1, port2 } = new MessageChannel();
      answerHelloWith(port2, fixtureSnapshot({ context: evaluationCase.context }));
      const client = connectFlags(port1);
      expect(await client.whenReady({ timeout: 1000 })).toBe(true);
      const details = evaluate(client, evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
      const expected = oracle(evaluationCase);
      expect([details.value, details.variant, details.reason, details.errorCode]).toEqual([
        expected.value,
        expected.variant,
        expected.reason,
        expected.errorCode,
      ]);
      client.close();
      port2.close();
    });
  }

  for (const evaluationCase of PRECOMPUTED_CASES) {
    it(`precomputed parity \u2039 ${evaluationCase.name} (frames)`, () => {
      const { client, push } = connectOverFrames();
      push(precomputedSnapshot());
      const details = evaluate(client, evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
      const expected = precomputedOracle(evaluationCase);
      expect([details.value, details.variant, details.reason, details.errorCode]).toEqual([
        expected.value,
        expected.variant,
        expected.reason,
        expected.errorCode,
      ]);
    });

    it(`precomputed parity \u2039 ${evaluationCase.name} (port)`, async () => {
      const { port1, port2 } = new MessageChannel();
      answerHelloWith(port2, precomputedSnapshot());
      const client = connectFlags(port1);
      expect(await client.whenReady({ timeout: 1000 })).toBe(true);
      const details = evaluate(client, evaluationCase.type, evaluationCase.flagKey, evaluationCase.defaultValue);
      const expected = precomputedOracle(evaluationCase);
      expect([details.value, details.variant, details.reason, details.errorCode]).toEqual([
        expected.value,
        expected.variant,
        expected.reason,
        expected.errorCode,
      ]);
      client.close();
      port2.close();
    });
  }

  it('typed getters return the default with TYPE_MISMATCH and never throw', () => {
    const { client, push } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext }));
    expect(client.getBooleanDetails('targeted-flag', false)).toMatchObject({
      value: false,
      errorCode: 'TYPE_MISMATCH',
    });
    expect(client.getNumberValue('targeted-flag', 7)).toBe(7);
    expect(() => client.getObjectValue('targeted-flag', { a: 1 })).not.toThrow();
  });

  it('whenReady resolves true on READY/STALE and false on timeout or DISABLED', async () => {
    vi.useFakeTimers();
    const ready = connectOverFrames();
    const readyPromise = ready.client.whenReady({ timeout: 1000 });
    ready.push(fixtureSnapshot({ status: 'STALE' }));
    expect(await readyPromise).toBe(true);
    expect(await ready.client.whenReady()).toBe(true);

    const timedOut = connectOverFrames();
    const timeoutPromise = timedOut.client.whenReady({ timeout: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await timeoutPromise).toBe(false);

    const disabled = connectOverFrames();
    const disabledPromise = disabled.client.whenReady({ timeout: 1000 });
    disabled.push(minimalFlagsSnapshot('DISABLED'));
    expect(await disabledPromise).toBe(false);
    expect(disabled.client.status).toBe('DISABLED');
  });

  it('onStatusChange fires on every status change, including ERROR → READY recovery', () => {
    const { client, push } = connectOverFrames();
    const statuses: string[] = [];
    const unsubscribe = client.onStatusChange((status) => statuses.push(status));
    push(fixtureSnapshot({ revision: 1, status: 'READY' }));
    push(fixtureSnapshot({ revision: 2, status: 'READY', configurationRevision: 2 }));
    push(fixtureSnapshot({ revision: 3, status: 'ERROR', configuration: undefined }));
    push(fixtureSnapshot({ revision: 4, status: 'READY', configurationRevision: 3 }));
    unsubscribe();
    push(fixtureSnapshot({ revision: 5, status: 'STALE' }));
    expect(statuses).toEqual(['READY', 'ERROR', 'READY']);
  });

  it('requestContextUpdate resolves with the main response; reads keep the old context until the new snapshot arrives; times out to accepted false', async () => {
    vi.useFakeTimers();
    const { client, toMain, push } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext, contextRevision: 1 }));
    const pending = client.requestContextUpdate({ targetingKey: 'user-free', plan: 'free' });
    const request = toMain.find((message) => message.type === 'context-request') as {
      id: number;
      payload: string;
    };
    expect(JSON.parse(request.payload)).toEqual({ targetingKey: 'user-free', plan: 'free' });
    client.receive(encodeFrame(contextResponseMessage(request.id, true, 2)));
    expect(await pending).toEqual({ accepted: true, contextRevision: 2 });
    expect(client.getStringValue('targeted-flag', 'default')).toBe(oracle(CASES[0]).value);
    push(fixtureSnapshot({ revision: 2, context: { targetingKey: 'user-free', plan: 'free' }, contextRevision: 2 }));
    expect(client.getStringValue('targeted-flag', 'default')).toBe(oracle(CASES[1]).value);

    const timesOut = client.requestContextUpdate({ targetingKey: 'nobody' });
    await vi.advanceTimersByTimeAsync(CONTEXT_REQUEST_TIMEOUT);
    expect(await timesOut).toEqual({ accepted: false });
  });

  it('records carry the contextRevision captured at resolution and no value or context', async () => {
    vi.useFakeTimers();
    const { client, push, records, toMain } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext, contextRevision: 3 }));
    const details = client.getStringDetails('targeted-flag', 'default');
    push(fixtureSnapshot({ revision: 2, context: { targetingKey: 'other' }, contextRevision: 4 }));
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    const evaluator = new FlagsEvaluator();
    evaluator.apply(fixtureSnapshot({ context: proContext }));
    expect(records()).toEqual([
      {
        flagKey: 'targeted-flag',
        variant: details.variant,
        allocationKey: details.flagMetadata.allocationKey,
        reason: details.reason,
        doLog: true,
        serialId: details.flagMetadata.__dd_split_serial_id,
        configurationId: evaluator.resolve('string', 'targeted-flag', 'default').flagMetadata
          .__dd_core_configuration_id,
        contextRevision: 3,
        timestamp: expect.any(Number) as number,
      },
    ]);
    const payload = toMain.find((message) => message.type === 'evaluations') as { payload: string };
    expect(payload.payload).not.toContain('"value"');
    expect(payload.payload).not.toContain('user-pro');
  });

  it('batching and pre-dedupe follow the renderer rules (1000 ms / 50, ≤ 100 / 64 KiB; exposure-only pre-dedupe)', async () => {
    vi.useFakeTimers();
    const { client, push, batches, records } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext }));
    client.getStringValue('targeted-flag', 'default');
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL - 1);
    expect(batches()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches()).toHaveLength(1);
    for (let index = 0; index < 49; index += 1) client.getStringValue('targeted-flag', 'default');
    expect(batches()).toHaveLength(1);
    client.getStringValue('targeted-flag', 'default');
    expect(batches()).toHaveLength(2);
    expect(batches()[1].records).toHaveLength(50);

    const reporter = (client as unknown as { reporter: { records: unknown[] } }).reporter;
    reporter.records = Array.from({ length: 250 }, (_, index) => ({ ...records()[0], flagKey: `f-${index}` }));
    client.close();
    const all = batches().slice(2);
    expect(all.flatMap((batch) => batch.records)).toHaveLength(250);
    for (const batch of all) {
      expect(batch.records.length).toBeLessThanOrEqual(100);
      expect(JSON.stringify(batch).length).toBeLessThanOrEqual(MAX_BATCH_BYTES);
    }

    const exposureOnly = connectOverFrames();
    exposureOnly.push(fixtureSnapshot({ tracking: { exposures: true, rum: false, evaluations: false } }));
    exposureOnly.client.getStringValue('targeted-flag', 'default');
    exposureOnly.client.getStringValue('targeted-flag', 'default');
    exposureOnly.client.getBooleanValue('missing-flag', false);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    expect(exposureOnly.records().map((record) => record.flagKey)).toEqual(['targeted-flag']);
  });

  it('RUM-only tracking still sends every RUM-eligible record, doLog false included (R2)', async () => {
    vi.useFakeTimers();
    const { client, push, records } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext, tracking: { exposures: false, rum: true, evaluations: false } }));
    client.getStringValue('targeted-flag', 'default');
    client.getStringValue('unlogged-flag', 'app-default');
    client.getStringValue('unlogged-flag', 'app-default');
    client.getBooleanValue('missing-flag', false);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    // Main correlates RUM per evaluation time, so repeats are not pre-deduped; errors carry no variant for RUM.
    expect(records().map((record) => [record.flagKey, record.doLog])).toEqual([
      ['targeted-flag', true],
      ['unlogged-flag', false],
      ['unlogged-flag', false],
    ]);
  });

  it('sends nothing only when exposures, metrics and RUM are all off', async () => {
    vi.useFakeTimers();
    const { client, push, batches } = connectOverFrames();
    push(fixtureSnapshot({ tracking: { exposures: false, rum: false, evaluations: false } }));
    client.getStringValue('targeted-flag', 'default');
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    expect(batches()).toEqual([]);
  });

  it('an invariant throw is reported in batch.errors and the returned value is unchanged', async () => {
    vi.useFakeTimers();
    const { client, push, batches } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext }));
    const reporter = (client as unknown as { reporter: { add: (record: unknown) => void } }).reporter;
    reporter.add = () => {
      throw new Error('x'.repeat(2000));
    };
    expect(client.getStringValue('targeted-flag', 'default')).toBe(oracle(CASES[0]).value);
    await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
    const errors = batches().flatMap((batch) => batch.errors ?? []);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toHaveLength(1024);
  });

  it('connectFlags(undefined) warns once and returns defaults', async () => {
    const client = connectFlags(undefined);
    connectFlags(undefined);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(client.status).toBe('NOT_READY');
    expect(client.getBooleanValue('anything', true)).toBe(true);
    expect(await client.requestContextUpdate({ targetingKey: 'x' })).toEqual({ accepted: false });
    expect(await client.whenReady({ timeout: 10 })).toBe(false);
  });

  it('close() settles every pending whenReady with false right away and clears their timers (R5)', async () => {
    vi.useFakeTimers();
    const { client } = connectOverFrames();
    const settled: boolean[] = [];
    void client.whenReady({ timeout: 60_000 }).then((ready) => settled.push(ready));
    void client.whenReady({ timeout: 60_000 }).then((ready) => settled.push(ready));
    expect(vi.getTimerCount()).toBe(2);
    client.close();
    await Promise.resolve();
    expect(settled).toEqual([false, false]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('an endpoint disconnect settles pending whenReady with false and clears their timers (R5)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { port1, port2 } = new MessageChannel();
    const client = connectFlags(port1);
    const pending = client.whenReady({ timeout: 60_000 });
    expect(vi.getTimerCount()).toBe(1);
    const closed = new Promise<void>((resolve) => port1.once('close', () => resolve()));
    port2.close();
    await closed;
    expect(await pending).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('whenReady() after close() resolves false even when the last snapshot was READY (R5)', async () => {
    const { client, push } = connectOverFrames();
    push(fixtureSnapshot({ context: proContext }));
    expect(await client.whenReady({ timeout: 10 })).toBe(true);
    client.close();
    expect(await client.whenReady({ timeout: 10 })).toBe(false);
  });

  describe('onChange (F1)', () => {
    it('fires once with the new revision for a newer snapshot while the status stays READY', () => {
      const { client, push } = connectOverFrames();
      push(fixtureSnapshot({ revision: 3, context: proContext }));
      const events: unknown[] = [];
      client.onChange((event) => events.push(event));
      push(fixtureSnapshot({ revision: 4, configurationRevision: 2, context: proContext }));
      expect(events).toEqual([{ revision: 4, status: 'READY' }]);
    });

    it('fires on a status change and not for a snapshot with the same or an older revision', () => {
      const { client, push } = connectOverFrames();
      const events: unknown[] = [];
      client.onChange((event) => events.push(event));
      push(fixtureSnapshot({ revision: 5, context: proContext }));
      push(fixtureSnapshot({ revision: 5, context: proContext }));
      push(fixtureSnapshot({ revision: 4, context: proContext }));
      push(fixtureSnapshot({ revision: 6, status: 'ERROR', configuration: undefined, context: proContext }));
      expect(events).toEqual([
        { revision: 5, status: 'READY' },
        { revision: 6, status: 'ERROR' },
      ]);
    });

    it('unsubscribes, and a throwing listener is reported and does not stop the others', async () => {
      vi.useFakeTimers();
      const { client, push, batches } = connectOverFrames();
      const kept: number[] = [];
      const removed: number[] = [];
      client.onChange(() => {
        throw new Error('listener failure');
      });
      client.onChange((event) => kept.push(event.revision));
      const unsubscribe = client.onChange((event) => removed.push(event.revision));
      push(fixtureSnapshot({ revision: 1, contextRevision: 1, context: proContext }));
      unsubscribe();
      push(fixtureSnapshot({ revision: 2, contextRevision: 2, context: proContext }));
      expect(kept).toEqual([1, 2]);
      expect(removed).toEqual([1]);
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      expect(
        batches()
          .flatMap((batch) => batch.errors ?? [])
          .map((error) => error.message)
      ).toContain('listener failure');
    });

    it('stays quiet for a newer snapshot that changes neither the rules, the context nor the status (A5)', () => {
      const { client, push } = connectOverFrames();
      push(fixtureSnapshot({ revision: 3, configurationRevision: 1, contextRevision: 1, context: proContext }));
      const events: unknown[] = [];
      client.onChange((event) => events.push(event));
      // Only the tracking toggles changed: the revision moves, the flags cannot have.
      push(
        fixtureSnapshot({
          revision: 4,
          configurationRevision: 1,
          contextRevision: 1,
          context: proContext,
          tracking: { exposures: false, rum: true, evaluations: false },
        })
      );
      expect(events).toEqual([]);
      push(fixtureSnapshot({ revision: 5, configurationRevision: 1, contextRevision: 2, context: proContext }));
      push(fixtureSnapshot({ revision: 6, configurationRevision: 2, contextRevision: 2, context: proContext }));
      expect(events).toEqual([
        { revision: 5, status: 'READY' },
        { revision: 6, status: 'READY' },
      ]);
    });

    it('does not fire after close()', () => {
      const { client, push } = connectOverFrames();
      const events: unknown[] = [];
      client.onChange((event) => events.push(event));
      client.close();
      push(fixtureSnapshot({ revision: 9, context: proContext }));
      expect(events).toEqual([]);
    });

    it('is cleared when the endpoint disconnects', async () => {
      const { port1, port2 } = new MessageChannel();
      const client = connectFlags(port1);
      const events: unknown[] = [];
      client.onChange((event) => events.push(event));
      const closed = new Promise<void>((resolve) => port1.once('close', () => resolve()));
      port2.close();
      await closed;
      (client as unknown as { applySnapshot: (snapshot: FlagsSnapshot) => void }).applySnapshot(
        fixtureSnapshot({ revision: 9, context: proContext })
      );
      expect(events).toEqual([]);
    });
  });

  it('close() flushes, releases the endpoint and clears timers', async () => {
    const { port1, port2 } = new MessageChannel();
    const received: ChildMessage[] = [];
    port2.on('message', (message: unknown) => {
      if (isChildMessage(message)) received.push(message);
      if (isChildMessage(message) && message.type === 'hello') {
        port2.postMessage(snapshotMessage(JSON.stringify(fixtureSnapshot({ context: proContext }))));
      }
    });
    const client = connectFlags(port1);
    expect(await client.whenReady({ timeout: 1000 })).toBe(true);
    client.getStringValue('targeted-flag', 'default');
    const closed = new Promise<void>((resolve) => port2.once('close', () => resolve()));
    client.close();
    await closed;
    expect(received.map((message) => message.type)).toEqual(['hello', 'evaluations']);
    expect(client.getStringDetails('targeted-flag', 'default').errorCode).toBe('PROVIDER_NOT_READY');
  });
});

function answerHelloWith(port: MessagePort, snapshot: FlagsSnapshot) {
  port.on('message', (message: unknown) => {
    if (isChildMessage(message) && message.type === 'hello') {
      port.postMessage(snapshotMessage(JSON.stringify(snapshot)));
    }
  });
}
