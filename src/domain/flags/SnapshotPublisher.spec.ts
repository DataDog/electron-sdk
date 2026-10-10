import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

interface FakeFrame {
  origin: string;
  url: string;
  processId: number;
  routingId: number;
  destroyed: boolean;
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
}

const { frames, webContentsByFrame } = vi.hoisted(() => ({
  frames: new Map<string, unknown>(),
  webContentsByFrame: new Map<string, unknown>(),
}));

vi.mock('electron', () => ({
  webFrameMain: { fromId: (processId: number, routingId: number) => frames.get(`${processId}:${routingId}`) },
  webContents: {
    fromFrame: (frame: { processId: number; routingId: number }) =>
      webContentsByFrame.get(`${frame.processId}:${frame.routingId}`),
  },
}));

import { SnapshotPublisher, startDisabledFlagsResponder } from './SnapshotPublisher';
import { FlagsState } from './FlagsState';
import { addPendingSubscriber, getFlagsHolder } from '../../common/flags/flagsHolder';
import { parseFlagsSnapshot } from '../../common/flags/flagsPayloads';

let nextWebContentsId = 1;

function makeWebContents() {
  return Object.assign(new EventEmitter(), { id: nextWebContentsId++ }) as unknown as Electron.WebContents &
    EventEmitter;
}

function makeFrame(origin: string, processId: number, routingId: number, webContents?: unknown): FakeFrame {
  const frame: FakeFrame = {
    origin,
    url: `${origin}/index.html`,
    processId,
    routingId,
    destroyed: false,
    send: vi.fn(),
    isDestroyed: () => frame.destroyed,
  };
  frames.set(`${processId}:${routingId}`, frame);
  if (webContents !== undefined) webContentsByFrame.set(`${processId}:${routingId}`, webContents);
  return frame;
}

function request(frame: FakeFrame | undefined, sender?: unknown) {
  const handler = getFlagsHolder().flagsStateHandler!;
  return JSON.parse(handler({ senderFrame: frame, sender } as unknown as Electron.IpcMainInvokeEvent) as string) as {
    status: string;
    context?: unknown;
    revision: number;
  };
}

const pushedStatuses = (frame: FakeFrame) =>
  frame.send.mock.calls.map((call) => (JSON.parse(call[1] as string) as { status: string }).status);

describe('SnapshotPublisher', () => {
  let state: FlagsState;
  let publisher: SnapshotPublisher;

  beforeEach(() => {
    frames.clear();
    webContentsByFrame.clear();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
    state = new FlagsState({ targetingKey: 'anon' });
    state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
    publisher = new SnapshotPublisher(state, ['app.example.com']);
  });

  it('serves the snapshot only to frames allowed by the init-time allowedRendererHosts', () => {
    publisher.start();
    const webContents = makeWebContents();
    expect(request(makeFrame('https://app.example.com', 1, 1), webContents)).toMatchObject({
      status: 'READY',
      context: { targetingKey: 'anon' },
    });
    expect(request(makeFrame('https://evil.com', 1, 2), webContents)).toEqual(
      expect.objectContaining({ status: 'DISABLED', revision: 0 })
    );
  });

  it('while NOT_READY, serves and pushes the minimal NOT_READY snapshot the renderer parser accepts', () => {
    const notReady = new FlagsState({ targetingKey: 'anon' });
    const notReadyPublisher = new SnapshotPublisher(notReady, ['app.example.com']);
    notReadyPublisher.start();
    const frame = makeFrame('https://app.example.com', 1, 9, makeWebContents());
    const served = getFlagsHolder().flagsStateHandler!({
      senderFrame: frame,
      sender: undefined,
    } as unknown as Electron.IpcMainInvokeEvent) as string;
    expect(parseFlagsSnapshot(served)).toEqual(expect.objectContaining({ status: 'NOT_READY', revision: 0 }));
    expect(JSON.parse(served)).not.toHaveProperty('context');
    // A context change while still NOT_READY pushes nothing a renderer would reject.
    notReady.applyContextUpdate({ targetingKey: 'user', plan: 'pro' });
    for (const [, json] of frame.send.mock.calls as [string, string][]) {
      expect(parseFlagsSnapshot(json)).toBeDefined();
    }
    notReadyPublisher.stop();
  });

  it('answers DISABLED to a disallowed frame and does not subscribe it', () => {
    publisher.start();
    const evil = makeFrame('https://evil.com', 1, 2);
    request(evil, makeWebContents());
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(evil.send).not.toHaveBeenCalled();
  });

  it('re-checks pending pre-init subscribers at init and pushes only to allowed ones', () => {
    const webContents = makeWebContents();
    const allowed = makeFrame('https://app.example.com', 1, 1, webContents);
    const evil = makeFrame('https://evil.com', 1, 2, webContents);
    addPendingSubscriber(allowed);
    addPendingSubscriber(evil);
    publisher.start();
    expect(pushedStatuses(allowed)).toEqual(['READY']);
    expect(evil.send).not.toHaveBeenCalled();
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(pushedStatuses(allowed)).toEqual(['READY', 'READY']);
    expect(evil.send).not.toHaveBeenCalled();
  });

  it("re-checks the frame's current origin before every push and drops it if no longer allowed", () => {
    publisher.start();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, makeWebContents());
    frame.origin = 'https://evil.com';
    frame.url = 'https://evil.com/';
    state.applyContextUpdate({ targetingKey: 'user' });
    frame.origin = 'https://app.example.com';
    frame.url = 'https://app.example.com/';
    state.applyContextUpdate({ targetingKey: 'user-2' });
    expect(frame.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'did-frame-navigate of that frame',
      (wc: EventEmitter) => wc.emit('did-frame-navigate', {}, '', 200, '', true, 1, 1),
    ],
    ['render-process-gone', (wc: EventEmitter) => wc.emit('render-process-gone', {}, { reason: 'crashed' })],
    ['destroyed', (wc: EventEmitter) => wc.emit('destroyed')],
  ])('drops the subscription on %s', (_label, trigger) => {
    publisher.start();
    const webContents = makeWebContents();
    const frame = makeFrame('https://app.example.com', 1, 1);
    const sibling = makeFrame('https://app.example.com', 1, 9);
    request(frame, webContents);
    request(sibling, makeWebContents());
    trigger(webContents);
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).not.toHaveBeenCalled();
    expect(sibling.send).toHaveBeenCalledTimes(1);
  });

  it('a did-frame-navigate of another frame keeps the subscription', () => {
    publisher.start();
    const webContents = makeWebContents();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, webContents);
    webContents.emit('did-frame-navigate', {}, '', 200, '', false, 1, 7);
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).toHaveBeenCalledTimes(1);
  });

  it('pushes to the subscribing frame, not other frames of the same webContents', () => {
    publisher.start();
    const webContents = makeWebContents();
    const subscribed = makeFrame('https://app.example.com', 1, 1);
    const other = makeFrame('https://app.example.com', 1, 2);
    request(subscribed, webContents);
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(subscribed.send).toHaveBeenCalledTimes(1);
    expect(other.send).not.toHaveBeenCalled();
  });

  it('re-subscription after reload or navigation is idempotent and re-checked', () => {
    publisher.start();
    const webContents = makeWebContents();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, webContents);
    webContents.emit('did-frame-navigate', {}, '', 200, '', true, 1, 1);
    request(frame, webContents);
    request(frame, webContents);
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).toHaveBeenCalledTimes(1);
    expect(webContents.listenerCount('did-frame-navigate')).toBe(1);
  });

  it('a crashed then reloaded webContents receives the current snapshot', () => {
    publisher.start();
    const webContents = makeWebContents();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, webContents);
    webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    state.applyContextUpdate({ targetingKey: 'user' });
    const reloaded = makeFrame('https://app.example.com', 2, 1);
    expect(request(reloaded, webContents)).toMatchObject({ status: 'READY', context: { targetingKey: 'user' } });
  });

  it('skips destroyed frames', () => {
    publisher.start();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, makeWebContents());
    frame.destroyed = true;
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).not.toHaveBeenCalled();
  });

  it('gives no answer to an excluded session and never subscribes or pushes to it, pending frames included', () => {
    const excludedContents = makeWebContents();
    const pendingExcluded = makeFrame('https://app.example.com', 5, 1, excludedContents);
    addPendingSubscriber(pendingExcluded);
    publisher = new SnapshotPublisher(state, ['app.example.com'], (sender) => sender === excludedContents);
    publisher.start();
    const frame = makeFrame('https://app.example.com', 5, 2);
    const handler = getFlagsHolder().flagsStateHandler!;
    expect(handler({ senderFrame: frame, sender: excludedContents } as unknown as Electron.IpcMainInvokeEvent)).toBe(
      undefined
    );
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).not.toHaveBeenCalled();
    expect(pendingExcluded.send).not.toHaveBeenCalled();
    expect(request(makeFrame('https://app.example.com', 6, 1), makeWebContents()).status).toBe('READY');
  });

  it('stop() removes the handler, the state subscription and the webContents listeners', () => {
    publisher.start();
    const webContents = makeWebContents();
    const frame = makeFrame('https://app.example.com', 1, 1);
    request(frame, webContents);
    publisher.stop();
    state.applyContextUpdate({ targetingKey: 'user' });
    expect(frame.send).not.toHaveBeenCalled();
    expect(getFlagsHolder().flagsStateHandler).toBeUndefined();
    expect(webContents.listenerCount('did-frame-navigate')).toBe(0);
    expect(webContents.listenerCount('render-process-gone')).toBe(0);
    expect(webContents.listenerCount('destroyed')).toBe(0);
  });
});

describe('startDisabledFlagsResponder', () => {
  beforeEach(() => {
    frames.clear();
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:flagsHolder')];
  });

  it('answers the minimal DISABLED snapshot and tells pending pre-init subscribers', () => {
    const pending = makeFrame('https://evil.com', 1, 1);
    addPendingSubscriber(pending);
    startDisabledFlagsResponder();
    expect(pushedStatuses(pending)).toEqual(['DISABLED']);
    expect(request(makeFrame('https://app.example.com', 1, 2))).toEqual({
      revision: 0,
      status: 'DISABLED',
      contextRevision: 0,
      configurationRevision: 0,
      tracking: { exposures: false, rum: false, evaluations: false },
    });
  });
});
