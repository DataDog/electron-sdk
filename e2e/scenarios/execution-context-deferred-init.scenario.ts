import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { Intake } from '../lib/intake';
import { MainPage } from '../lib/mainPage';
import { createUserDataDir, cleanupUserDataDir, launchDeferredInitApp } from '../lib/helpers';

interface ExecutionContextEvent {
  execution_context: { id: string; type: 'main-process' | 'renderer-process' };
  _dd: { document_version: number };
}

// Runs init() in the main process via the deferred-init test hook (no renderer needed).
async function runInit(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(async () => {
    await (globalThis as unknown as { __ddE2E: { init: () => Promise<void> } }).__ddE2E.init();
  });
}

// Opens the app window via the deferred-init test hook and waits for it to finish loading.
async function openWindow(electronApp: ElectronApplication): Promise<Page> {
  const [window] = await Promise.all([
    electronApp.waitForEvent('window'),
    electronApp.evaluate(() => {
      (globalThis as unknown as { __ddE2E: { openWindow: () => void } }).__ddE2E.openWindow();
    }),
  ]);
  await window.waitForLoadState('load', { timeout: 10_000 });
  return window;
}

// A webContents created before init() has no renderer bridge yet to flush its own transport, so this
// asks the SDK's own bridge/IPC surface (wired regardless of the renderer's own RUM SDK) directly.
async function flushTransport(window: Page): Promise<void> {
  await new MainPage(window).flushTransport();
}

test.describe('execution context: renderer backfill on deferred init', () => {
  let intake: Intake;
  let userDataDir: string;
  let electronApp: ElectronApplication;

  test.beforeEach(async () => {
    intake = new Intake();
    await intake.start();
    userDataDir = await createUserDataDir();
    electronApp = await launchDeferredInitApp(intake, userDataDir, { enableExecutionContext: true });
  });

  test.afterEach(async () => {
    await electronApp.close();
    await cleanupUserDataDir(userDataDir);
    await intake.stop();
  });

  test('a window opened before init() gets backfilled with its own renderer execution context', async () => {
    // This window's webContents exists before ExecutionContextCollection is even created — only the
    // startup backfill (webContents.getAllWebContents()), not the 'web-contents-created' listener
    // (which only fires for windows created after it's attached), can pick it up.
    const window = await openWindow(electronApp);
    await runInit(electronApp);
    await flushTransport(window);

    const events = await intake.getEventsByType('execution_context');
    const rendererStart = events.find(
      (e) => (e.body as unknown as ExecutionContextEvent).execution_context.type === 'renderer-process'
    );
    expect(rendererStart).toBeDefined();
    expect((rendererStart!.body as unknown as ExecutionContextEvent)._dd.document_version).toBe(1);
  });
});
