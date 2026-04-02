import { test, expect, launchAppManually } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

test('emits a crash error event after a native crash', async ({ intake }) => {
  // Phase 1: Launch and crash
  const { electronApp: firstElectronApp, app: firstApp } = await launchAppManually(intake);
  await firstApp.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const sessionId = (viewEvents[0].body as RumViewEvent).session.id;

  const appClosed = firstElectronApp.waitForEvent('close');
  firstApp.crash();
  await appClosed;
  intake.clear();

  // Phase 2: Relaunch and verify crash event
  const { electronApp: secondElectronApp, app: secondApp } = await launchAppManually(intake);
  try {
    await secondApp.flushTransport();
    // increase timeout to account for crash dump processing
    const errorEvents = await intake.getEventsByType('error', 15_000);
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
  }
});
