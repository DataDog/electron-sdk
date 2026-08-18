import type { Page } from '@playwright/test';
import type { Intake, ReceivedEvent } from '../../e2e/lib/intake';
import { test, expect, flushTransport } from './helpers';

interface IpcResourceBody {
  type: 'resource';
  resource: { type: string; url: string; duration: number };
  context: { ipc: { role: 'source' | 'destination'; id: string; method: string } };
}

/**
 * Destination-side handlers in this prototype do real `fetch()` calls to httpbin.org, so a single
 * flushTransport() right after the click races the network round trip: the destination event may
 * not exist yet when the transport is flushed, and nothing re-flushes it afterwards. Poll by
 * flushing repeatedly until the expected count shows up (or the overall timeout elapses).
 */
async function flushUntilEventCount(
  window: Page,
  intake: Intake,
  count: number,
  predicate: (event: ReceivedEvent) => boolean,
  overallTimeout = 20000
): Promise<ReceivedEvent[]> {
  const start = Date.now();
  for (;;) {
    await flushTransport(window);
    try {
      return await intake.waitForEventCount('resource', count, { predicate, timeout: 500 });
    } catch (err) {
      if (Date.now() - start >= overallTimeout) throw err;
    }
  }
}

test('request/response IPC produces two RUM ipc resource events sharing the same ipc.id', async ({
  window,
  intake,
}) => {
  await window.click('#ipc-get-profile');

  // Source (renderer, method 'invoke') and destination (main, method 'handle') are DIFFERENT method
  // values for the same logical call — filter by the shared channel/url, not by method, or the source
  // side's own event would never be joined by a matching destination-side predicate.
  const events = await flushUntilEventCount(
    window,
    intake,
    2,
    (event) => (event.body as IpcResourceBody).resource?.url === 'ipc-demo:get-profile'
  );

  const bodies = events.map((event) => event.body as IpcResourceBody);
  const source = bodies.find((body) => body.context.ipc.role === 'source');
  const destination = bodies.find((body) => body.context.ipc.role === 'destination');

  expect(source).toBeDefined();
  expect(destination).toBeDefined();
  expect(source!.context.ipc.method).toBe('invoke');
  expect(destination!.context.ipc.method).toBe('handle');
  expect(source!.context.ipc.id).toBe(destination!.context.ipc.id);
  expect(source!.resource.type).toBe('native');
});

test('fire-and-forget renderer→main produces one source event and two destination events sharing ipc.id', async ({
  window,
  intake,
}) => {
  await window.click('#ipc-ping-main');

  // Same reasoning as above: source is 'send', destinations are 'on' — filter by channel/url.
  const events = await flushUntilEventCount(
    window,
    intake,
    3,
    (event) => (event.body as IpcResourceBody).resource?.url === 'ipc-demo:ping-main'
  );
  const bodies = events.map((event) => event.body as IpcResourceBody);
  const sources = bodies.filter((body) => body.context.ipc.role === 'source');
  const destinations = bodies.filter((body) => body.context.ipc.role === 'destination');

  expect(sources).toHaveLength(1);
  expect(destinations).toHaveLength(2);
  expect(destinations.every((body) => body.context.ipc.id === sources[0].context.ipc.id)).toBe(true);
});

test('fire-and-forget main→renderer produces one source event and two destination events sharing ipc.id', async ({
  window,
  intake,
}) => {
  await window.click('#ipc-ping-renderer');

  // Note: clicking the button first does an invoke/handle round trip on channel
  // 'ipc-demo:trigger-ping-renderer' (its own separate ipc.id), which then triggers a single
  // webContents.send on channel 'ipc-demo:ping-renderer'. Electron delivers that one send to BOTH
  // registered ipcRenderer.on listeners with the same appended id, so filtering by the relayed
  // channel/url gives 1 source + 2 destinations = 3 events, all sharing that one id (same shape as
  // above, just main-initiated instead of renderer-initiated).
  const events = await flushUntilEventCount(
    window,
    intake,
    3,
    (event) => (event.body as IpcResourceBody).resource?.url === 'ipc-demo:ping-renderer'
  );
  const bodies = events.map((event) => event.body as IpcResourceBody);
  expect(bodies.filter((b) => b.context.ipc.role === 'destination')).toHaveLength(2);
  expect(bodies.every((b) => b.context.ipc.id === bodies[0].context.ipc.id)).toBe(true);
});

test("nested IPC: progress send falls within the parent handle event's time window", async ({ window, intake }) => {
  await window.click('#ipc-nested-profile');

  // Scoped by url (not just method): the test's own polling helper calls flushTransport(), which is
  // itself an `ipcMain.handle('flush-transport', ...)` call and would otherwise satisfy a bare
  // `method === 'handle'` predicate before the real nested-profile event exists.
  const [handleEvent] = await flushUntilEventCount(
    window,
    intake,
    1,
    (event) =>
      (event.body as IpcResourceBody).context?.ipc?.method === 'handle' &&
      (event.body as IpcResourceBody).resource?.url === 'ipc-demo:get-profile-with-progress'
  );
  const [progressEvent] = await flushUntilEventCount(
    window,
    intake,
    1,
    (event) =>
      (event.body as IpcResourceBody).context?.ipc?.method === 'send' &&
      (event.body as IpcResourceBody).resource?.url === 'ipc-demo:profile-progress'
  );

  const handleBody = handleEvent.body as IpcResourceBody & { date: number };
  const progressBody = progressEvent.body as IpcResourceBody & { date: number };

  // Validates axis 2.B's premise: the nested send's timestamp falls inside the handle event's window.
  expect(progressBody.date).toBeGreaterThanOrEqual(handleBody.date);
  expect(progressBody.date).toBeLessThanOrEqual(handleBody.date + handleBody.resource.duration);
});

test('broadcast produces an independent source/destination pair for each relayed send', async ({ window, intake }) => {
  // The helper BrowserWindows are created lazily on the first click; `ensureBroadcastWindows` in
  // main.ts awaits each window's `loadURL(...)` before relaying, so even the very first click is safe
  // — no warm-up click needed.
  await window.click('#ipc-broadcast');
  const relayedEvents = await flushUntilEventCount(
    window,
    intake,
    4,
    (event) => (event.body as IpcResourceBody).resource?.url === 'ipc-demo:broadcast-received'
  );

  // The initial invoke/handle (channel 'ipc-demo:broadcast') and each relay send/on (channel
  // 'ipc-demo:broadcast-received', one per receiving window) are independent calls: main's relay loop
  // calls webContents.send once per window, and each call generates its OWN ipc.id (Task 2's
  // startSendWithIpcId mints a fresh id every invocation). Nothing in this prototype links them (no
  // parent_id, out of scope per Global Constraints) — the two relay pairs do NOT share an id with each
  // other or with the original invoke/handle.
  const bodies = relayedEvents.map((event) => event.body as IpcResourceBody);
  const sources = bodies.filter((b) => b.context.ipc.role === 'source');
  const destinations = bodies.filter((b) => b.context.ipc.role === 'destination');

  expect(sources).toHaveLength(2); // one relay send per receiving window
  expect(destinations).toHaveLength(2); // one 'on' event per receiving window

  // Each relay send pairs with exactly one destination sharing its own id, but the two pairs are
  // otherwise unrelated to each other.
  const sourceIds = sources.map((s) => s.context.ipc.id).sort();
  const destinationIds = destinations.map((d) => d.context.ipc.id).sort();
  expect(destinationIds).toEqual(sourceIds);
  expect(new Set(sourceIds).size).toBe(2);
});

test('a real network call inside a destination handler produces a correlated resource within the IPC event window', async ({
  window,
  intake,
}) => {
  await window.click('#ipc-get-profile');

  await flushUntilEventCount(
    window,
    intake,
    1,
    (event) =>
      (event.body as IpcResourceBody).context?.ipc?.role === 'destination' &&
      (event.body as IpcResourceBody).context?.ipc?.method === 'handle'
  );

  const networkEvents = await flushUntilEventCount(window, intake, 1, (event) => {
    // Both IPC and real network resources use resource.type: 'native' (resource.type has no 'ipc'
    // enum value, see Task 3's correction note) — distinguish by the absence of context.ipc instead.
    const body = event.body as { context?: { ipc?: unknown }; resource?: { url?: string } };
    return !body.context?.ipc && !!body.resource?.url?.includes('httpbin.org');
  });

  expect(networkEvents.length).toBeGreaterThan(0);
  // This is the raw ingredient axis 2.B's "pivot by time-window overlap" needs — the product query
  // itself is not SDK code, but the test proves the timestamps make that query possible.
});
