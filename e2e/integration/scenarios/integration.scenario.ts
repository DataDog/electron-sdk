/**
 * Integration test scenarios run against each realistic Electron app setup.
 *
 * Each test runs once per Playwright project (app × mode combination).
 */
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, expect, launchApp } from '../lib/integrationFixture';
import type { RumErrorEvent, RumResourceEvent, RumViewEvent } from '@datadog/electron-sdk';
import { Intake, type ReceivedEvent, type Span } from '../../lib/intake';
import type { Page } from '@playwright/test';
import { ONE_SECOND } from '@datadog/js-core/time';

// Renderer window global helpers exposed by each integration app's renderer code
interface IntegrationTestWindow {
  electronAPI?: {
    flushTransport: () => Promise<void>;
    crash: () => Promise<void>;
    mainFetch: (url: string) => Promise<number>;
  };
  __integrationTest?: {
    triggerRendererError: (message: string) => void;
  };
}

test.describe('view event on startup @integration', () => {
  test('sends a view event with a session id on startup', async ({ window, intake }) => {
    await flushTransport(window);

    const [event] = await intake.getEventsByType('view');
    const view = event.body as RumViewEvent;

    expect(view.type).toBe('view');
    expect(view.session.id).toBeDefined();
    expect(view.application.id).toBe('integration-test-app-id');
  });
});

// Test skipped: requires bridge preload — re-enable in step 2
test.describe.skip('renderer error propagation @integration', () => {
  test('propagates a renderer error to the intake', async ({ window, intake }) => {
    // Trigger a manual error via the renderer's exposed test helper
    await window.evaluate(() => {
      (globalThis as unknown as IntegrationTestWindow).__integrationTest?.triggerRendererError(
        'integration test error'
      );
    });

    // Wait for browser-rum to capture and send the error via the bridge IPC
    await window.waitForTimeout(ONE_SECOND);
    await flushTransport(window);

    const errorEvents = await intake.waitForEventCount('error', 1, { timeout: 10 * ONE_SECOND });
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body as RumErrorEvent;
    expect(error.type).toBe('error');
    expect(error.error.message).toBe('integration test error');
    expect(error.session.id).toBeDefined();
  });
});

// Test skipped: requires IPC context propagation — re-enable in step 3
test.describe.skip('main-process fetch resource @integration', () => {
  test('emits a resource event and a matching trace span for a main-process fetch', async ({
    window,
    intake,
    testServer,
  }) => {
    await flushTransport(window);
    const [viewEvent] = await intake.getEventsByType('view');
    const view = viewEvent.body as RumViewEvent;

    const url = testServer.urlFor(200);
    await window.evaluate((u) => (globalThis as unknown as IntegrationTestWindow).electronAPI?.mainFetch(u), url);
    await flushTransport(window);

    const resourceEvents = await intake.waitForEventCount('resource', 1, { timeout: 10 * ONE_SECOND });
    const resource = resourceEvents[0].body as RumResourceEvent;
    expect(resource.resource.method).toBe('GET');
    expect(resource.resource.status_code).toBe(200);
    expect(resource.resource.url).toBe(url);
    expect(resource.application.id).toBe(view.application.id);
    expect(resource.session.id).toBe(view.session.id);
    expect(resource.view.id).toBe(view.view.id);
    expect(resource._dd.trace_id).toBeDefined();
    expect(resource._dd.span_id).toBeDefined();

    const span = await intake.waitForSpan((s: Span) => BigInt(`0x${s.trace_id}`) === BigInt(resource._dd.trace_id!));
    expect(span.meta['_dd.application.id']).toBe(view.application.id);
    expect(span.meta['_dd.session.id']).toBe(view.session.id);
    expect(span.meta['_dd.view.id']).toBe(view.view.id);
    expect(span.service).toBe('integration-test-app');
  });
});

test.describe('crash reporting across restart @integration', () => {
  test('processes a crash dump and sends an error event on restart', async ({ app, mode }) => {
    const appDir = join(__dirname, '../apps', app);
    // The `intake` fixture is not used here because this test needs a single intake instance
    // across two separate app launches. The fixture ties teardown to the `electronApp` lifecycle,
    // so we manage the intake manually to span both launches.
    const intake = new Intake();
    await intake.start();
    const userDataDir = await mkdtemp(join(tmpdir(), 'electron-sdk-integration-'));

    try {
      // Phase 1: Launch, confirm SDK is running, then crash
      const firstApp = await launchApp(appDir, mode, intake, userDataDir);
      const firstWindow = await firstApp.firstWindow();
      await firstWindow.waitForLoadState('load');
      await firstWindow.waitForTimeout(500);
      await flushTransport(firstWindow);
      await intake.getEventsByType('view', { timeout: 10 * ONE_SECOND });

      const appClosed = firstApp.waitForEvent('close');
      void firstWindow
        .evaluate(() => {
          void (globalThis as unknown as IntegrationTestWindow).electronAPI?.crash();
        })
        .catch(() => {
          // expected: window disappears when the app crashes
        });
      await appClosed;
      intake.clear();

      // Phase 2: Relaunch — crash dump is processed on startup, error event sent to intake
      const secondApp = await launchApp(appDir, mode, intake, userDataDir);
      try {
        const secondWindow = await secondApp.firstWindow();
        await secondWindow.waitForLoadState('load');

        const errorEvents = await flushUntilEventArrives(secondWindow, intake, 'error', 1, 15 * ONE_SECOND);
        expect(errorEvents).toHaveLength(1);

        const error = errorEvents[0].body as RumErrorEvent;
        expect(error.error.is_crash).toBe(true);
        expect(error.error.source).toBe('source');
        expect(error.error.handling).toBe('unhandled');
        expect(error.error.stack).toBeTruthy();
      } finally {
        await secondApp.close();
      }
    } finally {
      await intake.stop();
      await rm(userDataDir, { recursive: true, force: true });
    }
  });
});

async function flushTransport(window: Page): Promise<void> {
  await window.evaluate(() => {
    return (globalThis as unknown as IntegrationTestWindow).electronAPI?.flushTransport();
  });
}

/**
 * Periodically flushes the transport and checks for events until `count` events of `type`
 * arrive or `timeout` ms elapses. Handles variable crash processing time across toolchains
 * and modes (e.g. slower when reading from an asar archive in packaged mode).
 */
async function flushUntilEventArrives(
  window: Page,
  intake: Intake,
  type: string,
  count: number,
  timeout: number
): Promise<ReceivedEvent[]> {
  const pollInterval = 500;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    await flushTransport(window).catch(() => {
      /* empty */
    });
    const received = await intake
      .waitForEventCount(type, count, { timeout: Math.min(pollInterval, deadline - Date.now()) })
      .catch(() => null);
    if (received) return received;
  }
  throw new Error(`Timed out waiting for ${count} "${type}" event(s) after ${timeout}ms`);
}
