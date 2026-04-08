import { test, expect } from '../lib/helpers';
import type { RumViewEvent, RumErrorEvent } from '@datadog/electron-sdk';

function isBridgeView(event: { body: unknown }): boolean {
  return (event.body as RumViewEvent).view.url !== 'electron://main-process';
}

test.describe('bridge window — file:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, mainPage, intake }) => {
    // Flush the initial main-process view
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const bridgeView = viewEvents.find(isBridgeView);

    expect(bridgeView).toBeDefined();
    const view = bridgeView!.body as RumViewEvent;
    expect(view.view.url).toContain('bridge-window.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — http:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeHttpWindow(electronApp);
    await mainPage.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const bridgeView = viewEvents.find(isBridgeView);

    expect(bridgeView).toBeDefined();
    const view = bridgeView!.body as RumViewEvent;
    expect(view.view.url).toMatch(/^http:\/\/localhost:\d+/);
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — contextIsolation: false', () => {
  test('renderer RUM view events arrive when contextIsolation is disabled', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    await mainPage.openBridgeFileWindowNoIsolation(electronApp);
    await mainPage.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const bridgeView = viewEvents.find(isBridgeView);

    expect(bridgeView).toBeDefined();
    const view = bridgeView!.body as RumViewEvent;
    expect(view.view.url).toContain('bridge-window.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('bridge window — event types', () => {
  test('renderer view events have correct attributes', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const bridgeView = viewEvents.find(isBridgeView)!.body as RumViewEvent;

    // Session attributes come from the main process (assembly hooks)
    expect(bridgeView.session.id).toBe(mainView.session.id);
    expect(bridgeView.application.id).toBe('e2e-test-app-id');
    expect(bridgeView.service).toBe('e2e-renderer');

    // View attributes come from the renderer's browser-rum
    expect(bridgeView.view.id).toBeDefined();
    expect(bridgeView.view.id).not.toBe(mainView.view.id);
  });

  test('renderer error events are captured with correct attributes', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    const bridgeWindowPage = await mainPage.openBridgeFileWindow(electronApp);

    // Throw an error in the renderer — browser-rum captures it via the bridge
    const errorMessage = 'renderer test error';
    await bridgeWindowPage.generateError(errorMessage);
    await mainPage.flushTransport();

    const errorEvents = await intake.waitForEventCount('error', 1, 10000);
    const rendererError = errorEvents.find((e) => (e.body as RumErrorEvent).error.message === errorMessage);

    expect(rendererError).toBeDefined();
    const error = rendererError!.body as RumErrorEvent;
    expect(error.error.source).toBe('source');
    // Session from main process
    expect(error.session.id).toBe(mainView.session.id);
  });

  test('renderer resource events are captured', async ({ electronApp, mainPage, intake }) => {
    // Use http:// window so fetch works (file:// has CORS restrictions)
    const bridgeWindowPage = await mainPage.openBridgeHttpWindow(electronApp);

    await bridgeWindowPage.generateResource();
    await mainPage.flushTransport();

    const resourceEvents = await intake.getEventsByType('resource');
    expect(resourceEvents.length).toBeGreaterThanOrEqual(1);
  });
});
