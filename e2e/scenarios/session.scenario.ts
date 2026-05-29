import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import type { TelemetryErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

test.use({ rumBrowserSdk: {} });

test('new session id is generated when renewing a session', async ({ mainPage, intake }) => {
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const firstEvents = await intake.getEventsByType('telemetry');
  const firstSessionId = (firstEvents[0].body as TelemetryErrorEvent).session?.id;
  expect(firstSessionId).toMatch(/^[0-9a-f-]+$/);

  await mainPage.renewSession();
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const allEvents = await intake.waitForEventCount('telemetry', 2);
  const secondSessionId = (allEvents[1].body as TelemetryErrorEvent).session?.id;
  expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);

  expect(secondSessionId).not.toBe(firstSessionId);
});

test('creates a new session on each app launch', async ({ intake }) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: Launch app and capture session ID
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const firstViewEvents = await intake.getEventsByType('view');
  const firstSessionId = (firstViewEvents[0].body as RumViewEvent).session.id;
  await firstElectronApp.close();
  intake.clear();

  // Phase 2: Relaunch with the same userDataDir
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    const secondViewEvents = await intake.getEventsByType('view');
    const secondSessionId = (secondViewEvents[0].body as RumViewEvent).session.id;

    expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);
    expect(secondSessionId).not.toBe(firstSessionId);
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});
