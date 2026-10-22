import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessagePort } from 'node:worker_threads';
import * as fs from 'node:fs/promises';
import { OpenFeature } from '@openfeature/web-sdk';
import { display } from '../../tools/display';
import { EventKind, EventManager, EventSource, EventTrack, type ServerEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';
import {
  contextRequestMessage,
  decodeFrame,
  encodeFrame,
  evaluationsMessage,
  helloMessage,
  MAX_CONTEXT_REQUEST_LENGTH,
  type ChildMessage,
} from '../../common/flags/childProtocol';
import { connectFlags, type ChildFlagsClient } from '../../child/flags/ChildFlagsClient';
import { FLUSH_INTERVAL } from '../../common/flags/EvaluationReporter';
import type { EvaluationRecord, FlagsSnapshot } from '../../common/flags/types';
import { FlagsState } from './FlagsState';
import { EvaluationBatchIntake, DROPPED_RECORDS_DEBUG_MESSAGE } from './EvaluationBatchIntake';
import type { AnonymousKeyStore } from './AnonymousKeyStore';
import {
  closeAllFlagsChannels,
  disableFlagsChildren,
  linkFlagsChildren,
  MAX_OPEN_CHANNELS,
  openFlagsChannel,
  openFlagsChannelCount,
} from './ChildFlagsHub';
import { ElectronMainFlagsProvider } from './ElectronMainFlagsProvider';
import { getFeatureFlagsController, startFeatureFlags, unregisterFlagsProvider } from './startFeatureFlags';
import { registerFlagsChannels } from '../../instrument/registerFlagsChannels';

const { ipcMain, addErrorMock, addDebugMock } = await vi.hoisted(async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  const emitter = new Emitter() as InstanceType<typeof Emitter> & {
    handlers: Map<string, (...args: unknown[]) => unknown>;
    handle: (channel: string, handler: (...args: unknown[]) => unknown) => void;
  };
  emitter.handlers = new Map();
  emitter.handle = (channel, handler) => emitter.handlers.set(channel, handler);
  return { ipcMain: emitter, addErrorMock: vi.fn(), addDebugMock: vi.fn() };
});

vi.mock('electron', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  /** A MessageChannelMain fake: `{ data, ports }` events, start() gating, close() closing both ends. */
  class FakeMessagePortMain extends Emitter {
    peer?: FakeMessagePortMain;
    started = false;
    queue: unknown[] = [];
    isClosed = false;
    postMessage(message: unknown) {
      if (this.isClosed) throw new Error('port closed');
      this.peer!.deliver(structuredClone(message));
    }
    deliver(data: unknown) {
      if (this.started) this.emit('message', { data, ports: [] });
      else this.queue.push(data);
    }
    start() {
      this.started = true;
      for (const data of this.queue.splice(0)) this.emit('message', { data, ports: [] });
    }
    close() {
      if (this.isClosed) return;
      this.isClosed = true;
      this.emit('close');
      this.peer?.close();
    }
  }
  class MessageChannelMain {
    port1 = new FakeMessagePortMain();
    port2 = new FakeMessagePortMain();
    constructor() {
      this.port1.peer = this.port2;
      this.port2.peer = this.port1;
    }
  }
  return {
    app: { getPath: vi.fn(() => '/userData') },
    ipcMain,
    MessageChannelMain,
    webFrameMain: { fromId: () => undefined },
    webContents: { fromFrame: () => undefined },
    session: { fromPartition: () => ({}) },
  };
});

vi.mock('../telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry')>()),
  addError: addErrorMock,
  addDebug: addDebugMock,
}));

vi.mock('node:fs/promises');

const ANONYMOUS_KEY = '123e4567-e89b-12d3-a456-426614174000';
const rulesBinary = Uint8Array.from(
  atob((JSON.parse(fixtureWire) as { rules: { response: string } }).rules.response),
  (c) => c.charCodeAt(0)
);
const okResponse = () =>
  new Response(rulesBinary.slice().buffer, { status: 200, headers: { 'content-type': 'application/protobuf' } });

/** A frames channel wired to a frames child client, through a JSON round trip each way. */
function connectFramesChild(options: { name?: string; onContextRequest?: () => boolean } = {}) {
  const toChild: string[] = [];
  const ref: { child?: ChildFlagsClient & { receive(frame: unknown): void } } = {};
  const channel = openFlagsChannel({
    kind: 'frames',
    ...options,
    send: (frame) => {
      toChild.push(frame);
      ref.child?.receive(JSON.parse(JSON.stringify(frame)) as unknown);
    },
  });
  const connected = connectFlags({ send: (frame) => channel.receive(JSON.parse(JSON.stringify(frame)) as unknown) });
  ref.child = connected;
  // Deliver what main sent before the child existed (the open-time push).
  for (const frame of toChild.splice(0)) connected.receive(frame);
  return { channel, child: connected, toChild };
}

/** A frames channel driven by hand: the test plays the child. */
function rawFramesChannel(options: { name?: string; owner?: EventEmitter } = {}) {
  const fromMain: ChildMessage[] = [];
  const channel = openFlagsChannel({
    kind: 'frames',
    ...(options.name !== undefined ? { name: options.name } : {}),
    ...(options.owner !== undefined ? { owner: options.owner } : {}),
    send: (frame) => fromMain.push(decodeFrame(frame)!),
  });
  const snapshots = () =>
    fromMain
      .filter((message) => message.type === 'snapshot')
      .map((message) => JSON.parse((message as { payload: string }).payload) as FlagsSnapshot);
  return { channel, fromMain, snapshots, send: (message: ChildMessage) => channel.receive(encodeFrame(message)) };
}

function readyState() {
  const state = new FlagsState({ targetingKey: ANONYMOUS_KEY });
  state.applyConfigurationUpdate({ configuration: fixtureWire, status: 'READY' });
  return state;
}

const keyStore = { anonymousKey: ANONYMOUS_KEY } as AnonymousKeyStore;

describe('ChildFlagsHub', () => {
  let unlink: (() => void) | undefined;

  beforeEach(() => {
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    addErrorMock.mockClear();
    addDebugMock.mockClear();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsChildren')];
  });

  afterEach(() => {
    unlink?.();
    unlink = undefined;
    closeAllFlagsChannels();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('channels', () => {
    it('worker kind returns a transferable node MessagePort; utility kind returns a MessagePortMain; frames kind sends string frames and accepts receive', async () => {
      unlink = linkFlagsChildren({ state: readyState(), intake: new EvaluationBatchIntake(() => undefined), keyStore });

      const worker = openFlagsChannel({ kind: 'worker', name: 'hash' });
      expect(worker.port).toBeInstanceOf(MessagePort);
      const workerChild = connectFlags(worker.port);
      expect(await workerChild.whenReady({ timeout: 1000 })).toBe(true);
      workerChild.close();

      const utility = openFlagsChannel({ kind: 'utility', name: 'indexer' });
      const utilityChild = connectFlags(utility.port as never);
      expect(await utilityChild.whenReady({ timeout: 1000 })).toBe(true);
      utilityChild.close();

      const { channel, child, toChild } = connectFramesChild({ name: 'server-host' });
      expect(child.status).toBe('READY');
      expect(typeof channel.receive).toBe('function');
      expect(toChild.every((frame) => typeof frame === 'string')).toBe(true);
    });

    it('pushes the snapshot on open, on hello and on every newer revision, never twice for the same revision', () => {
      const state = readyState();
      unlink = linkFlagsChildren({ state, intake: new EvaluationBatchIntake(() => undefined), keyStore });
      const { snapshots, send } = rawFramesChannel();
      expect(snapshots().map((snapshot) => snapshot.revision)).toEqual([1]);
      send(helloMessage());
      expect(snapshots().map((snapshot) => snapshot.revision)).toEqual([1, 1]);
      state.applyContextUpdate({ targetingKey: 'user-2' });
      state.applyConfigurationUpdate({ configuration: fixtureWire, status: 'READY' });
      expect(snapshots().map((snapshot) => snapshot.revision)).toEqual([1, 1, 2, 3]);
      // A re-notification of the same revision is not pushed again.
      (state as unknown as { notify: () => void }).notify();
      expect(snapshots().map((snapshot) => snapshot.revision)).toEqual([1, 1, 2, 3]);
    });

    it('before init answers hello with the minimal NOT_READY snapshot and pushes the real snapshot when the controller starts', () => {
      const { snapshots, send } = rawFramesChannel();
      send(helloMessage());
      expect(snapshots().map((snapshot) => snapshot.status)).toEqual(['NOT_READY', 'NOT_READY']);
      expect(snapshots()[0].context).toBeUndefined();
      unlink = linkFlagsChildren({ state: readyState(), intake: new EvaluationBatchIntake(() => undefined), keyStore });
      expect(snapshots().map((snapshot) => snapshot.status)).toEqual(['NOT_READY', 'NOT_READY', 'READY']);
    });

    it('after init without featureFlags answers DISABLED', () => {
      const { snapshots, send } = rawFramesChannel();
      disableFlagsChildren();
      send(helloMessage());
      expect(snapshots().map((snapshot) => snapshot.status)).toEqual(['NOT_READY', 'DISABLED', 'DISABLED']);
      const late = rawFramesChannel();
      expect(late.snapshots().map((snapshot) => snapshot.status)).toEqual(['DISABLED']);
    });

    it("closes itself on the peer port's close event and on owner exit, removing its exit listener and FlagsState subscription", async () => {
      const state = readyState();
      unlink = linkFlagsChildren({ state, intake: new EvaluationBatchIntake(() => undefined), keyStore });
      const worker = openFlagsChannel({ kind: 'worker', name: 'hash' });
      worker.port.close();
      await vi.waitFor(() => expect(worker.closed).toBe(true));

      const owner = new EventEmitter();
      const { channel, snapshots } = rawFramesChannel({ name: 'server-host', owner });
      expect(owner.listenerCount('exit')).toBe(1);
      owner.emit('exit');
      expect(channel.closed).toBe(true);
      expect(owner.listenerCount('exit')).toBe(0);
      state.applyContextUpdate({ targetingKey: 'user-2' });
      expect(snapshots()).toHaveLength(1);
      expect(openFlagsChannelCount()).toBe(0);
    });

    it('close() is idempotent; opening the same name closes the previous channel', () => {
      const first = rawFramesChannel({ name: 'server-host' });
      first.channel.close();
      first.channel.close();
      expect(first.channel.closed).toBe(true);
      const second = rawFramesChannel({ name: 'server-host' });
      const third = rawFramesChannel({ name: 'server-host' });
      expect(second.channel.closed).toBe(true);
      expect(third.channel.closed).toBe(false);
      expect(openFlagsChannelCount()).toBe(1);
    });

    it("never adds a listener to any app-owned object other than owner.once('exit')", () => {
      const owner = new EventEmitter();
      const before = process.listenerCount('message');
      const send = vi.fn();
      const channel = openFlagsChannel({ kind: 'frames', send, owner });
      expect(owner.eventNames()).toEqual(['exit']);
      expect(process.listenerCount('message')).toBe(before);
      channel.close();
      expect(owner.eventNames()).toEqual([]);
    });

    it('a throwing app send never escapes', () => {
      const channel = openFlagsChannel({
        kind: 'frames',
        name: 'broken',
        send: () => {
          throw new Error('channel closed');
        },
      });
      expect(() => channel.receive(encodeFrame(helloMessage()))).not.toThrow();
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining('broken'));
    });

    it('non-envelope frames and messages are ignored, with no telemetry', async () => {
      const intakeRecords: EvaluationRecord[] = [];
      unlink = linkFlagsChildren({
        state: readyState(),
        intake: new EvaluationBatchIntake((record) => intakeRecords.push(record)),
        keyStore,
      });
      const { channel, fromMain } = rawFramesChannel();
      for (const foreign of [
        { id: 1, method: 'ping' },
        '{"id":1}',
        42,
        null,
        encodeFrame(helloMessage()).replace('1', '2'),
      ]) {
        channel.receive(foreign);
      }
      const worker = openFlagsChannel({ kind: 'worker' });
      worker.port.postMessage({ id: 1, method: 'ping' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(fromMain).toHaveLength(1);
      expect(intakeRecords).toEqual([]);
      expect(addErrorMock).not.toHaveBeenCalled();
      expect(addDebugMock).not.toHaveBeenCalled();
      worker.port.close();
    });

    it('bounds open channels to 100', () => {
      const channels = Array.from({ length: MAX_OPEN_CHANNELS + 1 }, () => rawFramesChannel().channel);
      expect(openFlagsChannelCount()).toBe(MAX_OPEN_CHANNELS);
      expect(channels[0].closed).toBe(true);
      expect(channels[1].closed).toBe(false);
      expect(display.warn).toHaveBeenCalledWith(expect.stringContaining(String(MAX_OPEN_CHANNELS)));
    });
  });

  describe('with the feature flags controller', () => {
    let eventManager: EventManager;
    let serverEvents: ServerEvent[];
    let hooks: FormatHooks;
    let requestViewUpdate: ReturnType<typeof vi.fn<() => void>>;

    beforeEach(() => {
      vi.mocked(fs.readFile).mockImplementation((path: unknown) => {
        if (String(path).endsWith('_dd_flags_anonymous_key')) return Promise.resolve(ANONYMOUS_KEY);
        return Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
      });
      vi.mocked(fs.writeFile).mockResolvedValue(undefined);
      delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
      serverEvents = [];
      eventManager = new EventManager();
      eventManager.registerHandler<ServerEvent>({
        canHandle: (event): event is ServerEvent => event.kind === EventKind.SERVER,
        handle: (event) => serverEvents.push(event),
      });
      hooks = createFormatHooks();
      requestViewUpdate = vi.fn<() => void>();
    });

    afterEach(async () => {
      await getFeatureFlagsController()?.stop();
      unregisterFlagsProvider();
      ipcMain.removeAllListeners();
      ipcMain.handlers.clear();
    });

    async function startFlags(overrides: Record<string, unknown> = {}) {
      const controller = (await startFeatureFlags(
        createTestConfiguration({
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
        }),
        {
          eventManager,
          hooks,
          mainViewEmitter: { findViewId: () => 'main-view', requestViewUpdate },
          fetch: () => Promise.resolve(okResponse()),
        }
      ))!;
      await controller.settled();
      return controller;
    }

    /** The assignments response body `/precompute-assignments` returns for a targeting key. */
    const okPrecomputed = (targetingKey: string) =>
      new Response(JSON.stringify(precomputedResponseFor(targetingKey)), {
        status: 200,
        headers: { 'content-type': 'application/vnd.api+json' },
      });

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

    /** Read the subject of a precompute-assignments request body. */
    function precomputedSubjectOf(body: string): {
      targeting_key?: string;
      targeting_attributes?: Record<string, string | number | boolean>;
    } {
      try {
        return (
          (
            JSON.parse(body) as {
              data?: {
                attributes?: {
                  subject?: {
                    targeting_key?: string;
                    targeting_attributes?: Record<string, string | number | boolean>;
                  };
                };
              };
            }
          ).data?.attributes?.subject ?? {}
        );
      } catch {
        return {};
      }
    }

    async function startPrecomputedFlags(fetch: typeof globalThis.fetch) {
      const controller = (await startFeatureFlags(
        createTestConfiguration({
          featureFlags: {
            evaluationMode: 'precomputed',
            env: 'e2e',
            refreshInterval: 0,
            fetchTimeout: 500,
            persistConfiguration: false,
            enableExposureLogging: true,
            enableRumFeatureFlagTracking: true,
            enableFlagEvaluationTracking: true,
            excludedPartitions: [],
          },
        }),
        {
          eventManager,
          hooks,
          mainViewEmitter: { findViewId: () => 'main-view', requestViewUpdate },
          fetch,
        }
      ))!;
      await controller.settled();
      return controller;
    }

    const eligibleRecord = (overrides: Partial<EvaluationRecord> = {}): EvaluationRecord => ({
      flagKey: 'targeted-flag',
      variant: 'variant-a',
      allocationKey: 'targeted-pro',
      reason: 'TARGETING_MATCH',
      doLog: true,
      contextRevision: 1,
      timestamp: Date.now() as never,
      ...overrides,
    });

    const sendBatch = (send: (message: ChildMessage) => void, records: unknown[], errors?: unknown[]) =>
      send(evaluationsMessage(JSON.stringify({ records, ...(errors !== undefined ? { errors } : {}) })));

    const mainViewFlags = () =>
      (
        hooks.triggerRum({ eventType: 'view', startTime: Date.now() as never, source: EventSource.MAIN }) as
          { feature_flags?: Record<string, unknown> } | undefined
      )?.feature_flags;

    describe('records', () => {
      it('valid batches reach the exposure collector, the evaluation aggregator and the main RUM context', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { send } = rawFramesChannel({ name: 'server-host' });
        sendBatch(send, [eligibleRecord()]);
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
        expect(serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION)).toHaveLength(1);
        expect(requestViewUpdate).toHaveBeenCalled();
      });

      it('child records feed the main view feature_flags (D19)', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { send } = rawFramesChannel();
        sendBatch(send, [eligibleRecord()]);
        expect(mainViewFlags()).toEqual({ 'targeted-flag': 'variant-a' });
      });

      it('viewId and viewUrl from child records are stripped; exposures use electron://main-process', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { send } = rawFramesChannel();
        sendBatch(send, [eligibleRecord({ viewId: 'renderer-view', viewUrl: 'app://window/' })]);
        await controller.stop();
        const exposure = serverEvents.find((event) => event.track === EventTrack.EXPOSURES)!;
        expect((exposure.data as { rum: { view: { url: string } } }).rum.view.url).toBe('electron://main-process');
        const metric = serverEvents.find((event) => event.track === EventTrack.FLAGEVALUATION)!;
        expect(JSON.stringify(metric.data)).toContain('electron://main-process');
        expect(JSON.stringify(metric.data)).not.toContain('app://window/');
      });

      it.each([
        [
          'enableRumFeatureFlagTracking: false keeps child records off the main view',
          { enableRumFeatureFlagTracking: false },
          'rum',
        ],
        ['enableExposureLogging: false produces no child exposures', { enableExposureLogging: false }, 'exposures'],
        [
          'enableFlagEvaluationTracking: false sends no child metrics',
          { enableFlagEvaluationTracking: false },
          'metrics',
        ],
      ] as const)('child records follow the tracking toggles: %s', async (_label, overrides, sink) => {
        const controller = await startFlags(overrides);
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { send } = rawFramesChannel();
        sendBatch(send, [eligibleRecord()]);
        const flags = mainViewFlags();
        await controller.stop();
        const exposures = serverEvents.filter((event) => event.track === EventTrack.EXPOSURES);
        const metrics = serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION);
        expect(flags === undefined).toBe(sink === 'rum');
        expect(exposures.length === 0).toBe(sink === 'exposures');
        expect(metrics.length === 0).toBe(sink === 'metrics');
      });

      it('a late child record does not overwrite a newer main evaluation in the view or an error (R3)', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        controller.recordEvaluation(eligibleRecord({ variant: 'variant-new', timestamp: 200 as never }));
        const { send } = rawFramesChannel();
        sendBatch(send, [eligibleRecord({ variant: 'variant-old', timestamp: 100 as never })]);
        const errorFlags = (
          hooks.triggerRum({ eventType: 'error', startTime: 250 as never, source: EventSource.MAIN }) as
            { feature_flags?: Record<string, unknown> } | undefined
        )?.feature_flags;
        expect(mainViewFlags()).toEqual({ 'targeted-flag': 'variant-new' });
        expect(errorFlags).toEqual({ 'targeted-flag': 'variant-new' });
        await controller.stop();
      });

      it('oversize batches are dropped before parsing with the shared rate-limited debug', async () => {
        const controller = await startFlags();
        const { send } = rawFramesChannel();
        send(evaluationsMessage(`{"records":[${' '.repeat(64 * 1024)}]}`));
        expect(addDebugMock).toHaveBeenCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 1 });
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(0);
      });

      it('a batch within 64 KiB of UTF-16 units but over 64 KiB of UTF-8 bytes is dropped whole (R4)', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const records = Array.from({ length: 100 }, (_, index) =>
          eligibleRecord({ flagKey: `${index}${'€'.repeat(250)}` })
        );
        const json = JSON.stringify({ records });
        expect(json.length).toBeLessThan(64 * 1024);
        expect(Buffer.byteLength(json, 'utf8')).toBeGreaterThan(64 * 1024);
        const { send } = rawFramesChannel();
        send(evaluationsMessage(json));
        expect(addDebugMock).toHaveBeenCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 1 });
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION)).toHaveLength(0);
      });

      it('batch.errors reach addTelemetryError tagged as child, ≤ 5 × 1024 chars', async () => {
        await startFlags();
        const { send } = rawFramesChannel();
        sendBatch(
          send,
          [],
          Array.from({ length: 7 }, (_, index) => ({ message: `${index}${'m'.repeat(1200)}`, stack: 's'.repeat(1200) }))
        );
        expect(addErrorMock).toHaveBeenCalledTimes(5);
        for (const [error] of addErrorMock.mock.calls as [Error][]) {
          expect(error.name).toBe('ChildFlagsError');
          expect(error.message).toHaveLength(1024);
          expect(error.stack).toHaveLength(1024);
        }
      });

      it('the same tuple from main, a renderer and a child emits one exposure', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const record = eligibleRecord({ configurationId: 'config-1' });
        controller.recordEvaluation(record);
        ipcMain.emit(
          'datadog:flags-evaluations',
          { senderFrame: { origin: 'app://window', url: 'app://window/' } },
          JSON.stringify({ records: [{ ...record, viewUrl: 'app://window/' }] })
        );
        const { send } = rawFramesChannel();
        sendBatch(send, [record]);
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
      });

      it('a real child client reports its evaluations through the hub', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { child } = connectFramesChild();
        expect(child.getStringValue('targeted-flag', 'default')).toBe('variant-a');
        await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
      });

      it('RUM-only: a real child client still reports, and its flags (doLog false included) reach the main view (R2)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const controller = await startFlags({ enableExposureLogging: false, enableFlagEvaluationTracking: false });
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { child } = connectFramesChild();
        const targeted = child.getStringValue('targeted-flag', 'default');
        const unlogged = child.getStringDetails('unlogged-flag', 'app-default');
        expect(unlogged.flagMetadata.doLog).toBe(false);
        await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
        expect(mainViewFlags()).toEqual({ 'targeted-flag': targeted, 'unlogged-flag': unlogged.value });
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(0);
        expect(serverEvents.filter((event) => event.track === EventTrack.FLAGEVALUATION)).toHaveLength(0);
      });

      it('RUM off with exposures on: child records feed exposures only, never the main view (R2)', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const controller = await startFlags({
          enableRumFeatureFlagTracking: false,
          enableFlagEvaluationTracking: false,
        });
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { child } = connectFramesChild();
        child.getStringValue('targeted-flag', 'default');
        await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
        expect(mainViewFlags()).toBeUndefined();
        await controller.stop();
        expect(serverEvents.filter((event) => event.track === EventTrack.EXPOSURES)).toHaveLength(1);
      });

      it('a main context change and a rules refresh each reach the child onChange, status staying READY (F1)', async () => {
        const controller = await startFlags();
        const { child } = connectFramesChild();
        expect(child.status).toBe('READY');
        const events: { revision: number; status: string }[] = [];
        child.onChange((event) => events.push(event));
        controller.state.applyContextUpdate({ targetingKey: 'user-2', plan: 'pro' });
        const contextRevision = controller.state.snapshot().revision;
        // An identical rules refresh moves the revision but cannot change any flag: quiet (A5).
        controller.state.applyConfigurationUpdate({
          configuration: controller.state.snapshot().configuration,
          status: 'READY',
        });
        // New rules (same content, a new serialization) bump the configuration revision.
        controller.state.applyConfigurationUpdate({
          configuration: JSON.stringify(JSON.parse(controller.state.snapshot().configuration!), null, 1),
          status: 'READY',
        });
        const rulesRevision = controller.state.snapshot().revision;
        expect(rulesRevision).toBe(contextRevision + 2);
        expect(events).toEqual([
          { revision: contextRevision, status: 'READY' },
          { revision: rulesRevision, status: 'READY' },
        ]);
        await controller.stop();
      });

      it('controller stop() closes every channel', async () => {
        const controller = await startFlags();
        const { channel } = rawFramesChannel();
        await controller.stop();
        expect(channel.closed).toBe(true);
      });
    });

    describe('context', () => {
      const requestContext = (
        send: (message: ChildMessage) => void,
        fromMain: ChildMessage[],
        id: number,
        payload: string
      ) => {
        send(contextRequestMessage(id, payload));
        return fromMain.find(
          (message) => message.type === 'context-response' && (message as { id: number }).id === id
        ) as { accepted: boolean; contextRevision?: number } | undefined;
      };

      it('the response is delayed until an asynchronous context change (precomputed assignments) is applied', async () => {
        const state = readyState();
        let resolveAssignments: () => void = () => undefined;
        const assignmentsApplied = new Promise<void>((resolve) => {
          resolveAssignments = resolve;
        });
        unlink = linkFlagsChildren({
          state,
          intake: new EvaluationBatchIntake(() => undefined),
          keyStore,
          // Precomputed mode: the context change resolves once its assignments are applied.
          applyContextChange: (context) =>
            assignmentsApplied.then(() => {
              state.applyContextUpdate(context);
            }),
        });
        const { send, fromMain } = rawFramesChannel();
        send(contextRequestMessage(7, JSON.stringify({ targetingKey: 'user-late' })));
        // While the assignments are in flight: no response.
        expect(fromMain.filter((message) => message.type === 'context-response')).toHaveLength(0);
        resolveAssignments();
        await vi.waitFor(() =>
          expect(
            fromMain.find((message) => message.type === 'context-response' && (message as { id: number }).id === 7)
          ).toMatchObject({ accepted: true, contextRevision: state.snapshot().contextRevision })
        );
      });

      it('an accepted request applies the normalized context and the new snapshot reaches every child channel and the renderer publisher', async () => {
        registerFlagsChannels(ipcMain as unknown as Electron.IpcMain);
        const controller = await startFlags();
        const requester = rawFramesChannel({ name: 'server-host' });
        const other = rawFramesChannel({ name: 'indexer' });
        const response = requestContext(
          requester.send,
          requester.fromMain,
          1,
          JSON.stringify({ targetingKey: 'workspace-1', tier: 'pro' })
        );
        expect(response).toMatchObject({
          accepted: true,
          contextRevision: controller.state.snapshot().contextRevision,
        });
        expect(controller.state.snapshot().context).toEqual({ targetingKey: 'workspace-1', tier: 'pro' });
        for (const channel of [requester, other]) {
          expect(channel.snapshots()[channel.snapshots().length - 1].context).toEqual({
            targetingKey: 'workspace-1',
            tier: 'pro',
          });
        }
        const rendererSnapshot = JSON.parse(
          ipcMain.handlers.get('datadog:flags-snapshot')!({
            senderFrame: { origin: 'app://window', url: 'app://window/', processId: 1, routingId: 1 },
            sender: Object.assign(new EventEmitter(), { id: 1 }),
          }) as string
        ) as FlagsSnapshot;
        expect(rendererSnapshot.context).toEqual({ targetingKey: 'workspace-1', tier: 'pro' });
      });

      it('{} falls back to the anonymous key', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'someone' });
        const { send, fromMain } = rawFramesChannel();
        expect(requestContext(send, fromMain, 1, '{}')).toMatchObject({ accepted: true });
        expect(controller.state.snapshot().context).toEqual({ targetingKey: ANONYMOUS_KEY });
      });

      it('dropped keys warn in main; oversize or invalid requests are rejected', async () => {
        const controller = await startFlags();
        const { send, fromMain } = rawFramesChannel();
        expect(
          requestContext(send, fromMain, 1, JSON.stringify({ targetingKey: 'user', nested: { a: 1 } }))
        ).toMatchObject({ accepted: true });
        expect(display.warn).toHaveBeenCalledWith(expect.stringContaining('nested'));
        const revision = controller.state.snapshot().contextRevision;
        expect(
          requestContext(send, fromMain, 2, JSON.stringify({ targetingKey: 'x'.repeat(MAX_CONTEXT_REQUEST_LENGTH) }))
        ).toEqual(expect.objectContaining({ accepted: false }));
        expect(requestContext(send, fromMain, 3, '{not json')).toEqual(expect.objectContaining({ accepted: false }));
        expect(requestContext(send, fromMain, 4, '[1,2]')).toEqual(expect.objectContaining({ accepted: false }));
        expect(controller.state.snapshot().contextRevision).toBe(revision);
      });

      it('an identical context responds accepted with the current revision and no new revision', async () => {
        const controller = await startFlags();
        controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        const { send, fromMain, snapshots } = rawFramesChannel();
        const revision = controller.state.snapshot().contextRevision;
        const pushed = snapshots().length;
        expect(requestContext(send, fromMain, 1, JSON.stringify({ targetingKey: 'user-pro', plan: 'pro' }))).toEqual({
          __ddElectronSdkFlags: 1,
          type: 'context-response',
          id: 1,
          accepted: true,
          contextRevision: revision,
        });
        expect(controller.state.snapshot().contextRevision).toBe(revision);
        expect(snapshots()).toHaveLength(pushed);
      });

      it('onContextRequest returning false rejects every request; it receives the channel name; no revision or snapshot is published', async () => {
        const controller = await startFlags();
        const filter = vi.fn(() => false);
        const fromMain: ChildMessage[] = [];
        const channel = openFlagsChannel({
          kind: 'frames',
          name: 'server-host',
          onContextRequest: filter,
          send: (frame) => fromMain.push(decodeFrame(frame)!),
        });
        const child = connectFlags({ send: (frame) => channel.receive(frame) });
        for (const message of fromMain.splice(0)) child.receive(encodeFrame(message));
        const forward = () => {
          for (const message of fromMain.splice(0)) child.receive(encodeFrame(message));
        };
        const revision = controller.state.snapshot().revision;
        const first = child.requestContextUpdate({ targetingKey: 'workspace-1' });
        forward();
        const second = child.requestContextUpdate({ targetingKey: 'workspace-2', tier: 'pro' });
        forward();
        expect(await first).toEqual({ accepted: false });
        expect(await second).toEqual({ accepted: false });
        expect(filter).toHaveBeenCalledWith({ targetingKey: 'workspace-1' }, { name: 'server-host' });
        expect(controller.state.snapshot().revision).toBe(revision);
        expect(fromMain.filter((message) => message.type === 'snapshot')).toEqual([]);
      });

      it('requests before init are rejected', () => {
        const { send, fromMain } = rawFramesChannel();
        expect(requestContext(send, fromMain, 1, JSON.stringify({ targetingKey: 'x' }))).toEqual(
          expect.objectContaining({ accepted: false })
        );
      });

      it('a later main OpenFeature.setContext replaces a child-requested context', async () => {
        const controller = await startFlags();
        const provider = new ElectronMainFlagsProvider();
        await OpenFeature.setProviderAndWait(provider, { targetingKey: 'main-user' });
        const { send, fromMain } = rawFramesChannel();
        requestContext(send, fromMain, 1, JSON.stringify({ targetingKey: 'child-user' }));
        expect(controller.state.snapshot().context).toEqual({ targetingKey: 'child-user' });
        await OpenFeature.setContext({ targetingKey: 'main-user-2' });
        expect(controller.state.snapshot().context).toEqual({ targetingKey: 'main-user-2' });
        await OpenFeature.clearProviders();
      });

      it('a duplicate child context request awaits the matching in-flight assignments fetch', async () => {
        const requestedKeys: string[] = [];
        const pendingFetches: ((response: Response) => void)[] = [];
        const controller = await startPrecomputedFlags((_url?: unknown, init?: unknown) => {
          const targetingKey = precomputedSubjectOf((init as RequestInit | undefined)?.body as string).targeting_key;
          requestedKeys.push(targetingKey ?? '');
          if (targetingKey === ANONYMOUS_KEY) {
            return Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
          }
          return new Promise<Response>((resolve) => pendingFetches.push(resolve));
        });
        const { child } = connectFramesChild();
        expect(child.status).toBe('READY');
        const first = child.requestContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        let secondResult: { accepted: boolean; contextRevision?: number } | undefined;
        const second = child
          .requestContextUpdate({ targetingKey: 'user-pro', plan: 'pro' })
          .then((result) => (secondResult = result));
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The duplicate did not settle before the assignments arrived, and it did not
        // supersede the matching in-flight fetch with a second network request.
        expect(secondResult).toBeUndefined();
        expect(requestedKeys.filter((key) => key === 'user-pro')).toEqual(['user-pro']);
        pendingFetches[0](okPrecomputed('user-pro'));
        const [firstResult] = await Promise.all([first, second]);
        expect(firstResult).toMatchObject({ accepted: true });
        expect(secondResult).toMatchObject({ accepted: true });
        expect(firstResult.contextRevision).toBe(secondResult!.contextRevision);
        expect(controller.state.snapshot()).toMatchObject({
          status: 'READY',
          context: { targetingKey: 'user-pro', plan: 'pro' },
        });
      });

      it('a child reversion to the served context supersedes the pending one (pro → free → pro)', async () => {
        const requestedPlans: string[] = [];
        const pendingFetches: ((response: Response) => void)[] = [];
        const planOf = (init: RequestInit | undefined) =>
          precomputedSubjectOf(init?.body as string).targeting_attributes?.plan;
        const controller = await startPrecomputedFlags((_url?: unknown, init?: unknown) => {
          const targetingKey = precomputedSubjectOf((init as RequestInit | undefined)?.body as string).targeting_key;
          if (targetingKey === ANONYMOUS_KEY) {
            return Promise.resolve(okPrecomputed(ANONYMOUS_KEY));
          }
          requestedPlans.push(String(planOf(init as RequestInit | undefined)));
          return new Promise<Response>((resolve) => pendingFetches.push(resolve));
        });
        const { child } = connectFramesChild();
        expect(child.status).toBe('READY');
        // Establish the served context: user-pro with plan pro.
        const establish = child.requestContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        pendingFetches[0](okPrecomputed('user-pro'));
        await establish;
        expect(controller.state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'user-pro' } });
        // plan: free is requested (its fetch is pending), then the child reverts to the
        // served plan: pro. The reversion must supersede the pending free fetch.
        const changeToFree = child.requestContextUpdate({ targetingKey: 'user-pro', plan: 'free' });
        const revertToPro = child.requestContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(requestedPlans).toEqual(['pro', 'free', 'pro']);
        // The reverted-to context's assignments arrive first and are applied.
        pendingFetches[2](okPrecomputed('user-pro'));
        await revertToPro;
        expect(controller.state.snapshot()).toMatchObject({
          status: 'READY',
          context: { targetingKey: 'user-pro', plan: 'pro' },
        });
        // The superseded free response arrives late: it must never be applied.
        pendingFetches[1](okPrecomputed('user-pro'));
        await changeToFree;
        expect(controller.state.snapshot()).toMatchObject({
          status: 'READY',
          context: { targetingKey: 'user-pro', plan: 'pro' },
        });
      });
    });
  });
});
