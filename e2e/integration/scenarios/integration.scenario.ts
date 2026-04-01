/**
 * Integration test scenarios run against each realistic Electron app setup.
 *
 * Each test runs once per Playwright project (app × mode combination).
 */
import { join } from 'node:path';
import { test, expect, launchApp } from '../lib/integrationFixture';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';
import { Intake, type ReceivedEvent } from '../../lib/intake';
import type { Page } from '@playwright/test';
import { ONE_SECOND } from '@datadog/browser-core';

// Renderer window global helpers exposed by each integration app's renderer code
interface IntegrationTestWindow {
  electronAPI?: {
    flushTransport: () => Promise<void>;
    crash: () => Promise<void>;
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

test.describe('renderer error propagation @integration', () => {
  test('propagates a renderer error to the intake', async ({ window, intake }) => {
    // Trigger a manual error via the renderer's exposed test helper
    await window.evaluate(() => {
      (globalThis as unknown as IntegrationTestWindow).__integrationTest?.triggerRendererError(
        'integration test error'
      );
    });

    // Wait for browser-rum to capture and send the error via the bridge IPC
    await window.waitForTimeout(1000);
    await flushTransport(window);

    const errorEvents = await intake.waitForEventCount('error', 1, 10 * ONE_SECOND);
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body as RumErrorEvent;
    expect(error.type).toBe('error');
    expect(error.error.message).toBe('integration test error');
    expect(error.session.id).toBeDefined();
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

    try {
      // Phase 1: Launch, confirm SDK is running, then crash
      const firstApp = await launchApp(appDir, mode, intake);
      const firstWindow = await firstApp.firstWindow();
      await firstWindow.waitForLoadState('load');
      await firstWindow.waitForTimeout(500);
      await flushTransport(firstWindow);
      await intake.getEventsByType('view', 10_000);

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
      const secondApp = await launchApp(appDir, mode, intake);
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
      .waitForEventCount(type, count, Math.min(pollInterval, deadline - Date.now()))
      .catch(() => null);
    if (received) return received;
  }
  throw new Error(`Timed out waiting for ${count} "${type}" event(s) after ${timeout}ms`);
}
