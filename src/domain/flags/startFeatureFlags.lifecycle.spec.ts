import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { display } from '../../tools/display';
import { EventManager } from '../../event';
import { createFormatHooks } from '../../assembly';
import { createTestConfiguration } from '../../mocks.specUtil';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';
import { FLAGS_EVALUATIONS_CHANNEL } from '../../common';
import { getFlagsHolder } from '../../common/flags/flagsHolder';
import { connectFlags } from '../../child/flags/ChildFlagsClient';
import { FLUSH_INTERVAL } from '../../common/flags/EvaluationReporter';
import { closeAllFlagsChannels, openFlagsChannel } from './ChildFlagsHub';
import { FlagsOwner } from './FlagsOwner';
import { getFeatureFlagsController, startFeatureFlags, stopFeatureFlags } from './startFeatureFlags';

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

const rulesBinary = Uint8Array.from(
  atob((JSON.parse(fixtureWire) as { rules: { response: string } }).rules.response),
  (c) => c.charCodeAt(0)
);
const okResponse = () =>
  new Response(rulesBinary.slice().buffer, { status: 200, headers: { 'content-type': 'application/protobuf' } });

function flagsConfiguration() {
  return createTestConfiguration({
    featureFlags: {
      evaluationMode: 'rules',
      env: 'e2e',
      refreshInterval: 300_000,
      fetchTimeout: 500,
      persistConfiguration: false,
      enableExposureLogging: true,
      enableRumFeatureFlagTracking: true,
      enableFlagEvaluationTracking: true,
      excludedPartitions: [],
    },
  });
}

function start(fetch: () => Promise<Response> = () => Promise.resolve(okResponse())) {
  return startFeatureFlags(flagsConfiguration(), {
    eventManager: new EventManager(),
    hooks: createFormatHooks(),
    mainViewEmitter: { findViewId: () => 'main-view', requestViewUpdate: () => undefined },
    fetch,
  });
}

/** A frames child connected before startup, so it observes what main publishes. */
function connectChild() {
  const ref: { child?: ReturnType<typeof connectFlags> & { receive(frame: unknown): void } } = {};
  const pending: string[] = [];
  const channel = openFlagsChannel({
    kind: 'frames',
    send: (frame) => (ref.child ? ref.child.receive(frame) : pending.push(frame)),
  });
  ref.child = connectFlags({ send: (frame) => channel.receive(frame) });
  for (const frame of pending) ref.child.receive(frame);
  return ref.child;
}

/** The resources a running flags subsystem holds in main. */
function resources() {
  return {
    evaluationListeners: ipcMain.listenerCount(FLAGS_EVALUATIONS_CHANNEL),
    timers: vi.getTimerCount(),
    controller: getFeatureFlagsController() !== undefined,
    senderExclusion: getFlagsHolder().isSenderExcluded !== undefined,
  };
}

describe('feature flags startup and shutdown lifecycle', () => {
  beforeEach(() => {
    addErrorMock.mockClear();
    // Each case starts from a fresh process: no children or flags holder left by a previous case.
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsChildren')];
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    vi.mocked(fs.readFile).mockRejectedValue(new Error('ENOENT'));
    vi.mocked(fs.writeFile).mockResolvedValue(undefined);
    vi.mocked(fs.mkdir).mockResolvedValue(undefined);
    vi.spyOn(display, 'error').mockImplementation(() => undefined);
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await stopFeatureFlags();
    closeAllFlagsChannels();
    ipcMain.removeAllListeners();
    ipcMain.handlers.clear();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe('a failure late in startup (B6)', () => {
    it('releases everything already set up, falls back to flags off and does not reject', async () => {
      const baseline = resources();
      const child = connectChild();
      vi.spyOn(FlagsOwner, 'start').mockImplementationOnce(() => {
        throw new Error('late startup failure');
      });
      await expect(start()).resolves.toBeUndefined();
      expect(resources()).toEqual(baseline);
      expect(addErrorMock).toHaveBeenCalledWith(expect.objectContaining({ message: 'late startup failure' }));
      expect(display.error).toHaveBeenCalledWith(expect.stringContaining('Feature flags failed to start'));
      // Flags off: renderers and children are answered DISABLED.
      expect(child.status).toBe('DISABLED');
      expect(JSON.parse(getFlagsHolder().flagsStateHandler!({} as never) as string)).toMatchObject({
        status: 'DISABLED',
      });
    });
  });

  describe('a channel opened before startup', () => {
    it('gets the minimal NOT_READY snapshot while the first fetch is pending: no telemetry error', async () => {
      const child = connectChild();
      const controller = (await start(() => new Promise<Response>(() => undefined)))!;
      expect(controller.state.snapshot().status).toBe('NOT_READY');
      controller.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
      await vi.advanceTimersByTimeAsync(FLUSH_INTERVAL);
      expect(child.status).toBe('NOT_READY');
      expect(addErrorMock).not.toHaveBeenCalled();
    });
  });

  describe('re-initialization (B8)', () => {
    it('stops the previous controller first: one of each resource, the new controller serves', async () => {
      const first = (await start())!;
      await first.settled();
      const earlyChild = connectChild();
      const afterFirst = resources();
      expect(afterFirst.evaluationListeners).toBe(1);
      const second = (await start())!;
      await second.settled();
      // Let one-off timers (the first fetch's, the child's flush) run out before counting.
      await vi.advanceTimersByTimeAsync(1000);
      expect(resources()).toEqual(afterFirst);
      expect(addErrorMock).not.toHaveBeenCalled();
      expect(getFeatureFlagsController()).toBe(second);
      // The old controller no longer publishes: a context change on it reaches no child.
      const child = connectChild();
      const revision = second.state.snapshot().revision;
      first.state.applyContextUpdate({ targetingKey: 'stale', plan: 'free' });
      second.state.applyContextUpdate({ targetingKey: 'user-pro', plan: 'pro' });
      expect(child.getStringValue('targeted-flag', 'default')).toBe('variant-a');
      expect(second.state.snapshot().revision).toBe(revision + 1);
      // A channel opened before re-init stays open and follows the new controller.
      expect(earlyChild.status).toBe('READY');
      expect(earlyChild.getStringValue('targeted-flag', 'default')).toBe('variant-a');
    });

    it('stopFeatureFlags() releases every resource (re-init without featureFlags)', async () => {
      const baseline = resources();
      const controller = (await start())!;
      await controller.settled();
      await stopFeatureFlags();
      expect(resources()).toEqual(baseline);
    });
  });
});
