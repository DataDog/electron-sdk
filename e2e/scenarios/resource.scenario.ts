import { join } from 'node:path';
import { test, expect, e2eAppDirectory } from '../lib/helpers';
import type { RumResourceEvent } from '@datadog/electron-sdk';
import { byMessageResource, isMainProcessEvent, Span } from '../lib/intake';
import { MainPage } from '../lib/mainPage';
import { SLOW_RESPONSE_DELAY_MS } from '../lib/testServer';

function matchResourceTraceId(resource: RumResourceEvent) {
  return (span: Span) => BigInt(`0x${span.trace_id}`) === BigInt(resource._dd.trace_id!);
}

test('emits a resource event for a main-process fetch', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(200);
  await mainPage.mainFetch(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(200);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('emits a resource event for a main-process http.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(404);
  await mainPage.mainHttpRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(404);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('emits a resource event for a main-process net.request', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const url = testServer.urlFor(500);
  await mainPage.mainNetRequest(url);
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.method).toBe('GET');
  expect(resource.resource.status_code).toBe(500);
  expect(resource.resource.url).toBe(url);
  expect(resource.application.id).toBe(mainContext.application.id);
  expect(resource.session.id).toBe(mainContext.session.id);
  expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(resource._dd.trace_id).toBeDefined();
  expect(resource._dd.span_id).toBeDefined();

  const span = await intake.waitForSpan(matchResourceTraceId(resource));
  expect(span.meta['_dd.application.id']).toBe(mainContext.application.id);
  expect(span.meta['_dd.session.id']).toBe(mainContext.session.id);
  expect(span.meta['_dd.execution_context.id']).toBe(mainContext.execution_context.id);
  expect(span.service).toBe('e2e-test-app');
});

test('times a main-process net.request until its response headers', async ({ mainPage, intake, testServer }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  await mainPage.mainNetRequest(testServer.slowUrlFor(201));
  await mainPage.flushTransport();

  const resourceEvents = await intake.getEventsByType('resource');
  expect(resourceEvents).toHaveLength(1);

  const resource = resourceEvents[0].body;
  expect(resource.resource.status_code).toBe(201);
  expect(resource.resource.duration).toBeGreaterThanOrEqual(SLOW_RESPONSE_DELAY_MS * 1e6);

  const span = await intake.waitForSpan((span) => BigInt(`0x${span.span_id}`) === BigInt(resource._dd.span_id!));
  expect(span.meta['http.status_code']).toBe('201');
});

test('does not emit a resource event for SDK intake traffic', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  const intakeUrl = `http://localhost:${intake.getPort()}/api/v2/rum`;
  await mainPage.mainHttpRequest(intakeUrl);
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('resource');
});

const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HANDLER_DELAY_MS = 100;

test.describe('IPC resources', () => {
  test.use({ sdkConfigOverrides: { trackIpcResources: true } });

  test('reports an ipcMain handler call as a message resource', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const [{ body: mainContext }] = await intake.getEventsByType('execution_context', {
      predicate: isMainProcessEvent,
    });
    await electronApp.evaluate(({ ipcMain }, delay) => {
      ipcMain.handle('e2e:settings', () => new Promise((resolve) => setTimeout(() => resolve('value'), delay)));
    }, HANDLER_DELAY_MS);

    expect(await mainPage.invoke('e2e:settings')).toEqual({ result: 'value' });
    await mainPage.flushTransport();

    const resourceEvents = await intake.getSettledEventsByType('resource', {
      predicate: byMessageResource('e2e:settings'),
    });
    expect(resourceEvents).toHaveLength(1);

    const resource = resourceEvents[0].body;
    expect(resource.resource.message).toEqual({
      id: expect.stringMatching(UUID_REGEX),
      role: 'destination',
      api: 'handle',
      is_error: false,
    });
    // Node timers can fire slightly before their delay, as measured on the SDK's finer clock.
    expect(resource.resource.duration).toBeGreaterThanOrEqual((HANDLER_DELAY_MS - 10) * 1e6);
    expect(resource.application.id).toBe(mainContext.application.id);
    expect(resource.session.id).toBe(mainContext.session.id);
    expect(resource.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  });

  for (const target of ['webContents.ipc', 'webFrameMain.ipc'] as const) {
    test(`reports a call to a handler registered on ${target}, after a reload`, async ({
      electronApp,
      window: page,
      mainPage,
      intake,
    }) => {
      // Electron keeps both objects across a reload, and doesn't report the main frame again with frame-created.
      await page.reload();
      await electronApp.evaluate(({ BrowserWindow }, ipcTarget) => {
        const { webContents } = BrowserWindow.getAllWindows()[0];
        const ipc = ipcTarget === 'webContents.ipc' ? webContents.ipc : webContents.mainFrame.ipc;
        ipc.handle('e2e:settings', () => 'value');
      }, target);

      expect(await mainPage.invoke('e2e:settings')).toEqual({ result: 'value' });
      await mainPage.flushTransport();

      const resourceEvents = await intake.getSettledEventsByType('resource', {
        predicate: byMessageResource('e2e:settings'),
      });
      expect(resourceEvents).toHaveLength(1);
    });
  }

  test('reports a call to a handler registered on the webFrameMain.ipc of a window.open popup', async ({
    electronApp,
    window: page,
    intake,
  }) => {
    await electronApp.evaluate(
      ({ BrowserWindow }, preload) => {
        BrowserWindow.getAllWindows()[0].webContents.setWindowOpenHandler(() => ({
          action: 'allow',
          overrideBrowserWindowOptions: { webPreferences: { preload } },
        }));
      },
      join(e2eAppDirectory, 'dist/preload.js')
    );
    const [popup] = await Promise.all([
      electronApp.waitForEvent('window'),
      page.evaluate(() => {
        (globalThis as unknown as { open: (url: string) => void }).open('main-window.html');
      }),
    ]);
    await popup.waitForLoadState('load');
    await electronApp.evaluate(({ webContents }) => {
      const popupContents = webContents.getAllWebContents().find((contents) => contents.opener);
      popupContents!.mainFrame.ipc.handle('e2e:settings', () => 'value');
    });

    const popupPage = new MainPage(popup);
    expect(await popupPage.invoke('e2e:settings')).toEqual({ result: 'value' });
    await popupPage.flushTransport();

    const resourceEvents = await intake.getSettledEventsByType('resource', {
      predicate: byMessageResource('e2e:settings'),
    });
    expect(resourceEvents).toHaveLength(1);
  });

  test('flags a handler that rejects, whose error still reaches the renderer', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.handle('e2e:failing', () => Promise.reject(new Error('handler failed')));
    });

    expect(await mainPage.invoke('e2e:failing')).toEqual({ error: expect.stringContaining('handler failed') });
    await mainPage.flushTransport();

    const [{ body: resource }] = await intake.getEventsByType('resource', {
      predicate: byMessageResource('e2e:failing'),
    });
    expect(resource.resource.message?.is_error).toBe(true);
  });

  test('reports the single call a handleOnce handler answers', async ({ electronApp, mainPage, intake }) => {
    await electronApp.evaluate(({ ipcMain }) => {
      ipcMain.handleOnce('e2e:once', () => 'value');
    });

    expect(await mainPage.invoke('e2e:once')).toEqual({ result: 'value' });
    expect(await mainPage.invoke('e2e:once')).toEqual({ error: expect.stringContaining('No handler registered') });
    await mainPage.flushTransport();

    const resourceEvents = await intake.getSettledEventsByType('resource', {
      predicate: byMessageResource('e2e:once'),
    });
    expect(resourceEvents).toHaveLength(1);
  });
});

test('reports no IPC resource by default', async ({ electronApp, mainPage, intake }) => {
  await electronApp.evaluate(({ ipcMain }) => {
    ipcMain.handle('e2e:settings', () => 'value');
  });

  expect(await mainPage.invoke('e2e:settings')).toEqual({ result: 'value' });
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('resource');
});
