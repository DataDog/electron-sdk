import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

test('emits a crash error event after a native crash', async ({ intake }) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: Launch and crash
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const sessionId = (viewEvents[0].body as RumViewEvent).session.id;

  const appClosed = firstElectronApp.waitForEvent('close');
  firstMainPage.crash();
  await appClosed;
  intake.clear();

  // Phase 2: Relaunch and verify crash event
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    // increase timeout to account for crash dump processing
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body as RumErrorEvent;
    expect(error.session.id).toBe(sessionId);
    expect(error.error.is_crash).toBe(true);
    expect(error.error.source).toBe('source');
    expect(error.error.handling).toBe('unhandled');
    expect(error.error.category).toBe('Exception');
    expect(error.error.stack).toBeTruthy();
    expect(error.error.threads).toBeDefined();
    expect(error.error.binary_images).toBeDefined();
    expect(error.error.meta).toBeDefined();
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});
