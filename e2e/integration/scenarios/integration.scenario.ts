/**
 * Integration test scenarios run against each realistic Electron app setup.
 *
 * Each test runs once per Playwright project (app × mode, including configured variants).
 */
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { test, expect, launchApp } from '../lib/integrationFixture';
import { getElectronBuilderViteArchivePath } from '../lib/electronBuilderVite';
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
    openCustomSessionWindow: () => Promise<void>;
  };
  __integrationTest?: {
    triggerRendererError: (message: string) => void;
  };
}

test.describe('electron-builder runtime dependency packaging @integration', () => {
  test('stages Datadog dependencies according to the plugin option', ({ app, mode, variant }) => {
    test.skip(app !== 'electron-builder-vite' || mode !== 'packaged', 'electron-builder-vite packaged only');

    const appDir = join(__dirname, '../apps', app);
    const workflow = variant === 'packager-copy' ? 'packager-copy' : 'default-copy';
    const expectsPluginCopy = workflow === 'default-copy';
    expect(existsSync(join(appDir, 'dist', workflow, 'node_modules'))).toBe(expectsPluginCopy);

    const archivePath = getElectronBuilderViteArchivePath(appDir, variant);
    expect(existsSync(archivePath)).toBe(true);

    const requireFromApp = createRequire(join(appDir, 'package.json'));
    const { listPackage } = requireFromApp('@electron/asar') as {
      listPackage: (archivePath: string, options: { isPack: boolean }) => string[];
    };
    const archiveEntries = listPackage(archivePath, { isPack: false });

    expect(archiveEntries).toContain('/node_modules/@datadog/electron-sdk/package.json');
    expect(archiveEntries).toContain('/node_modules/dd-trace/package.json');
    expect(archiveEntries).toContain(`/dist/${workflow}/main.js`);
    expect(archiveEntries.includes(`/dist/${workflow}/node_modules/@datadog/electron-sdk/package.json`)).toBe(
      expectsPluginCopy
    );
    expect(archiveEntries.includes(`/dist/${workflow}/node_modules/dd-trace/package.json`)).toBe(expectsPluginCopy);
  });
});

test.describe('view event on startup @integration', () => {
  test('sends a view event with a session id on startup', async ({ window, intake }) => {
    const viewEvents = await flushUntilEventArrives(window, intake, 'view', 1, 15 * ONE_SECOND);
    expect(viewEvents).toHaveLength(1);
    const view = viewEvents[0].body as RumViewEvent;

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

test.describe('main-process fetch resource @integration', () => {
  test('emits a resource event and a matching trace span for a main-process fetch', async ({
    window,
    intake,
    testServer,
  }) => {
    const [viewEvent] = await flushUntilEventArrives(window, intake, 'view', 1, 15 * ONE_SECOND);
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

    // Regression guard for double-instrumentation. Each app follows the README
    // (`import '@datadog/electron-sdk/instrument'`) while also using a bundler plugin that injects
    // the instrumentation banner, so the instrumentation entry is evaluated twice (CJS banner +
    // ESM import). Without the idempotency guard, net.fetch is wrapped twice and emits duplicate
    // nested http.request spans. Assert exactly one span was recorded for this request.
    const requestSpans = intake.getSpans(
      (s) => s.name === 'http.request' && BigInt(`0x${s.trace_id}`) === BigInt(resource._dd.trace_id!)
    );
    expect(requestSpans).toHaveLength(1);
  });
});

test.describe('custom-session window instrumentation @integration', () => {
  test('injects the bridge preload into a window on a non-default session', async ({ window, electronApp, intake }) => {
    // Open a second window on a custom (persisted partition) session and grab its renderer page.
    const newWindow = electronApp.waitForEvent('window');
    await window.evaluate(() =>
      (globalThis as unknown as IntegrationTestWindow).electronAPI?.openCustomSessionWindow()
    );
    const customWindow = await newWindow;
    await customWindow.waitForLoadState('load');
    await customWindow.waitForTimeout(ONE_SECOND);

    // Trigger a renderer error in the custom-session window. It only reaches the intake if the SDK
    // registered the bridge preload on that custom session (via app 'session-created'), not just on
    // the default session.
    const message = 'custom-session renderer error';
    await customWindow.evaluate(
      (m) => (globalThis as unknown as IntegrationTestWindow).__integrationTest?.triggerRendererError(m),
      message
    );
    await customWindow.waitForTimeout(ONE_SECOND);

    const errors = await flushUntilEventArrives(window, intake, 'error', 1, 15 * ONE_SECOND);
    expect(errors.some((e) => (e.body as RumErrorEvent).error.message === message)).toBe(true);
  });
});

test.describe('crash reporting across restart @integration', () => {
  test('processes a crash dump and sends an error event on restart', async ({ app, mode, variant }) => {
    const appDir = join(__dirname, '../apps', app);
    // The `intake` fixture is not used here because this test needs a single intake instance
    // across two separate app launches. The fixture ties teardown to the `electronApp` lifecycle,
    // so we manage the intake manually to span both launches.
    const intake = new Intake();
    await intake.start();
    const userDataDir = await mkdtemp(join(tmpdir(), 'electron-sdk-integration-'));

    try {
      // Phase 1: Launch, confirm SDK is running, then crash
      const firstApp = await launchApp(appDir, mode, intake, userDataDir, variant);
      const firstWindow = await firstApp.firstWindow();
      await firstWindow.waitForLoadState('load');
      await firstWindow.waitForTimeout(500);
      await flushUntilEventArrives(firstWindow, intake, 'view', 1, 15 * ONE_SECOND);

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
      const secondApp = await launchApp(appDir, mode, intake, userDataDir, variant);
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
