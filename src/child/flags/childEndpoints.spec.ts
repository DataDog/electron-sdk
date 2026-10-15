import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { MessageChannel } from 'node:worker_threads';
import { display } from '../../tools/display';
import { encodeFrame, helloMessage, snapshotMessage, type ChildMessage } from '../../common/flags/childProtocol';
import { createDisconnectedEndpoint, createFramesEndpoint, createPortEndpoint } from './childEndpoints';

/** A MessagePortMain-shaped fake: emits `{ data, ports }` events, needs start(), has close(). */
function fakeMessagePortMain() {
  const emitter = new EventEmitter();
  const peer: unknown[] = [];
  const port = Object.assign(emitter, {
    started: false,
    closed: false,
    postMessage: vi.fn((message: unknown) => peer.push(message)),
    start: vi.fn(() => {
      port.started = true;
    }),
    close: vi.fn(() => {
      port.closed = true;
    }),
    deliver: (data: unknown) => emitter.emit('message', { data, ports: [] }),
  });
  return { port, peer };
}

const nextMessage = (port: import('node:worker_threads').MessagePort) =>
  new Promise<unknown>((resolve) => port.once('message', resolve));

describe('childEndpoints', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  const channels: MessageChannel[] = [];

  beforeEach(() => {
    warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    for (const channel of channels.splice(0)) {
      channel.port1.close();
      channel.port2.close();
    }
    vi.restoreAllMocks();
  });

  it('the port adapter reads Node values and MessagePortMain events alike', async () => {
    const channel = new MessageChannel();
    channels.push(channel);
    const nodeEndpoint = createPortEndpoint(channel.port1, 'node');
    const fromNode: ChildMessage[] = [];
    nodeEndpoint.setHandler((message) => fromNode.push(message));
    channel.port2.postMessage(helloMessage());
    channel.port2.postMessage({ id: 1, method: 'ping' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fromNode).toEqual([helloMessage()]);
    nodeEndpoint.send(snapshotMessage('{}'));
    expect(await nextMessage(channel.port2)).toEqual(snapshotMessage('{}'));

    const { port, peer } = fakeMessagePortMain();
    const mainEndpoint = createPortEndpoint(port, 'utility');
    const fromMain: ChildMessage[] = [];
    mainEndpoint.setHandler((message) => fromMain.push(message));
    port.deliver(helloMessage());
    port.deliver('not an envelope');
    expect(fromMain).toEqual([helloMessage()]);
    mainEndpoint.send(snapshotMessage('{}'));
    expect(peer).toEqual([snapshotMessage('{}')]);
  });

  it('starts the port when start() exists and unrefs it when unref() exists', () => {
    const { port } = fakeMessagePortMain();
    createPortEndpoint(port, 'utility').setHandler(() => undefined);
    expect(port.start).toHaveBeenCalledTimes(1);

    const channel = new MessageChannel();
    channels.push(channel);
    const unref = vi.spyOn(channel.port1, 'unref');
    createPortEndpoint(channel.port1, 'worker').setHandler(() => undefined);
    expect(unref).toHaveBeenCalled();
  });

  it('close() removes exactly its listener and closes the port', () => {
    const { port } = fakeMessagePortMain();
    const appListener = vi.fn();
    port.on('message', appListener);
    const endpoint = createPortEndpoint(port, 'utility');
    const onClose = vi.fn();
    endpoint.setHandler(() => undefined, onClose);
    expect(port.listenerCount('message')).toBe(2);
    endpoint.close();
    expect(port.listenerCount('message')).toBe(1);
    expect(port.listenerCount('close')).toBe(0);
    expect(port.close).toHaveBeenCalledTimes(1);
    expect(endpoint.connected).toBe(false);
    port.deliver(helloMessage());
    expect(appListener).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when the peer closes the port', async () => {
    const channel = new MessageChannel();
    const endpoint = createPortEndpoint(channel.port1, 'worker');
    const closed = new Promise<void>((resolve) => endpoint.setHandler(() => undefined, resolve));
    channel.port2.close();
    await closed;
    expect(endpoint.connected).toBe(false);
  });

  it('the frames adapter sends only strings and ignores non-string or foreign frames in receive', () => {
    const sent: unknown[] = [];
    const endpoint = createFramesEndpoint((frame) => sent.push(frame), 'server-host');
    const received: ChildMessage[] = [];
    endpoint.setHandler((message) => received.push(message));
    endpoint.send(helloMessage());
    expect(sent).toEqual([encodeFrame(helloMessage())]);
    for (const foreign of [helloMessage(), 42, null, '{"id":1,"method":"ping"}', '{not json']) {
      endpoint.receive(foreign);
    }
    expect(received).toEqual([]);
    endpoint.receive(encodeFrame(snapshotMessage('{}')));
    expect(received).toEqual([snapshotMessage('{}')]);
  });

  it('an undefined endpoint yields a disconnected endpoint', () => {
    const endpoint = createDisconnectedEndpoint();
    expect(endpoint.connected).toBe(false);
    expect(() => endpoint.send(helloMessage())).not.toThrow();
  });

  it('a throwing app send is caught and warned once', () => {
    const endpoint = createFramesEndpoint(() => {
      throw new Error('channel closed');
    }, 'server-host');
    expect(() => endpoint.send(helloMessage())).not.toThrow();
    expect(() => endpoint.send(helloMessage())).not.toThrow();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('server-host'));

    const { port } = fakeMessagePortMain();
    port.postMessage.mockImplementation(() => {
      throw new Error('port closed');
    });
    const portEndpoint = createPortEndpoint(port, 'indexer');
    portEndpoint.send(helloMessage());
    portEndpoint.send(helloMessage());
    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(warnSpy).toHaveBeenLastCalledWith(expect.stringContaining('indexer'));
  });
});
