import { test, expect } from '../lib/helpers';
import type { ElectronApplication } from '@playwright/test';
import type { RumViewEvent, RumErrorEvent } from '@datadog/electron-sdk';

/**
 * Helper: wait for a new renderer window to open and its bridge to be ready.
 * Returns the Playwright Page for the renderer window.
 */
async function waitForRendererWindow(electronApp: ElectronApplication) {
  const newPage = await electronApp.waitForEvent('window');
  await newPage.waitForSelector('#status');
  await newPage.waitForFunction('document.getElementById("status")?.textContent === "bridge-ready"');
  return newPage;
}

function isRendererView(event: { body: unknown }): boolean {
  return (event.body as RumViewEvent).view.url !== 'electron://main-process';
}

test.describe('renderer bridge — file:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, app, intake }) => {
    // Flush the initial main-process view
    await app.flushTransport();
    await intake.getEventsByType('view');

    // Open a file:// renderer window with browser-rum
    await app.openRendererFileWindow();
    const rendererWindow = await waitForRendererWindow(electronApp);
    expect(rendererWindow).toBeDefined();

    await app.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const rendererView = viewEvents.find(isRendererView);

    expect(rendererView).toBeDefined();
    const view = rendererView!.body as RumViewEvent;
    expect(view.view.url).toContain('index-renderer.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('renderer bridge — http:// window', () => {
  test('renderer RUM view events arrive at the intake via the bridge', async ({ electronApp, app, intake }) => {
    await app.flushTransport();
    await intake.getEventsByType('view');

    // Open an http:// renderer window
    await app.openRendererHttpWindow();
    const rendererWindow = await waitForRendererWindow(electronApp);
    expect(rendererWindow).toBeDefined();

    await app.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const rendererView = viewEvents.find(isRendererView);

    expect(rendererView).toBeDefined();
    const view = rendererView!.body as RumViewEvent;
    expect(view.view.url).toMatch(/^http:\/\/localhost:\d+/);
    expect(view.session.id).toBeDefined();
  });
});

test.describe('renderer bridge — contextIsolation: false', () => {
  test('renderer RUM view events arrive when contextIsolation is disabled', async ({ electronApp, app, intake }) => {
    await app.flushTransport();
    await intake.getEventsByType('view');

    await app.openRendererFileWindowNoIsolation();
    const rendererWindow = await waitForRendererWindow(electronApp);
    expect(rendererWindow).toBeDefined();

    await app.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const rendererView = viewEvents.find(isRendererView);

    expect(rendererView).toBeDefined();
    const view = rendererView!.body as RumViewEvent;
    expect(view.view.url).toContain('index-renderer.html');
    expect(view.session.id).toBeDefined();
  });
});

test.describe('renderer bridge — event types', () => {
  test('renderer view events have correct attributes', async ({ electronApp, app, intake }) => {
    await app.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    await app.openRendererFileWindow();
    await waitForRendererWindow(electronApp);
    await app.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 2);
    const rendererView = viewEvents.find(isRendererView)!.body as RumViewEvent;

    // Session attributes come from the main process (assembly hooks)
    expect(rendererView.session.id).toBe(mainView.session.id);
    expect(rendererView.application.id).toBe('e2e-test-app-id');
    expect(rendererView.service).toBe('e2e-renderer');

    // View attributes come from the renderer's browser-rum
    expect(rendererView.view.id).toBeDefined();
    expect(rendererView.view.id).not.toBe(mainView.view.id);
  });

  test('renderer error events are captured with correct attributes', async ({ electronApp, app, intake }) => {
    await app.flushTransport();
    const mainViewEvents = await intake.getEventsByType('view');
    const mainView = mainViewEvents[0].body as RumViewEvent;

    await app.openRendererFileWindow();
    const rendererWindow = await waitForRendererWindow(electronApp);

    // Throw an error in the renderer — browser-rum captures it via the bridge
    await rendererWindow.evaluate(() => {
      setTimeout(() => {
        throw new Error('renderer test error');
      }, 0);
    });

    // Wait for the error to propagate: renderer browser-rum → bridge IPC → main process → transport
    await rendererWindow.waitForTimeout(1000);
    await app.flushTransport();

    const errorEvents = await intake.waitForEventCount('error', 1, 10000);
    const rendererError = errorEvents.find((e) => (e.body as RumErrorEvent).error.message === 'renderer test error');

    expect(rendererError).toBeDefined();
    const error = rendererError!.body as RumErrorEvent;
    expect(error.error.source).toBe('source');
    // Session from main process
    expect(error.session.id).toBe(mainView.session.id);
  });

  test('renderer resource events are captured', async ({ electronApp, app, intake }) => {
    // Use http:// window so fetch works (file:// has CORS restrictions)
    await app.openRendererHttpWindow();
    const rendererWindow = await waitForRendererWindow(electronApp);

    // Trigger a fetch from the renderer — browser-rum tracks resources
    await rendererWindow.evaluate(() => fetch('/'));

    await app.flushTransport();

    const resourceEvents = await intake.getEventsByType('resource');
    expect(resourceEvents.length).toBeGreaterThanOrEqual(1);
  });
});
