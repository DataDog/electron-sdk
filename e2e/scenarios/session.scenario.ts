import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { byMainProcessTelemetryType, isBridgeView, type ReceivedEvent } from '../lib/intake';
import type { RumViewEvent } from '@datadog/electron-sdk';
import { ONE_SECOND } from '@datadog/js-core/time';

/**
 * The SDK's own error telemetry. The main window runs the browser SDK in these tests, and the SDK
 * relays that SDK's telemetry too, so reading by telemetry type alone could pick a renderer event.
 */
const isMainProcessError = byMainProcessTelemetryType('log');

/** Selects the views of the main window page: with execution context enabled, the main process view is a fake one. */
const isPageView = (event: ReceivedEvent<RumViewEvent>): boolean => isBridgeView(event) && !event.body.view.is_fake;

test.use({ rumBrowserSdk: {} });

test('new session id is generated when renewing a session', async ({ mainPage, intake }) => {
  test.setTimeout(60 * ONE_SECOND);
  await mainPage.generateTelemetryErrors(1);
  await mainPage.flushTransport();

  const firstEvents = await intake.getEventsByType('telemetry', { predicate: isMainProcessError });
  const firstSessionId = firstEvents[0].body.session?.id;
  expect(firstSessionId).toMatch(/^[0-9a-f-]+$/);

  await mainPage.renewSession();
  await mainPage.generateTelemetryErrors(1);
  await mainPage.flushTransport();

  const allEvents = await intake.waitForEventCount('telemetry', 2, {
    predicate: isMainProcessError,
    timeout: 30 * ONE_SECOND,
  });
  const secondSessionId = allEvents[1].body.session?.id;
  expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);

  expect(secondSessionId).not.toBe(firstSessionId);
});

test.describe('with execution context', () => {
  test.use({ sdkConfigOverrides: { enableExecutionContext: true } });

  test('a page left open across a session renewal moves its view to the new session', async ({ mainPage, intake }) => {
    test.setTimeout(60 * ONE_SECOND);
    await mainPage.flushTransport();
    const [{ body: firstView }] = await intake.waitForEventCount('view', 1, { predicate: isPageView });

    await mainPage.renewSession();
    // Renderer activity in the new session, so the open page sends a view update.
    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const [{ body: renewedContext }] = await intake.waitForEventCount('execution_context', 1, {
      predicate: (event) =>
        event.body.execution_context.type === 'main-process' && event.body.session.id !== firstView.session.id,
    });

    // Fake views do not create sessions in the backend: the new session needs the page's real view. The browser SDK
    // throttles view updates, so keep flushing until it lands.
    await expect
      .poll(
        async () => {
          await mainPage.flushTransport();
          return (
            intake.getReceivedEvents('view', {
              predicate: (event) =>
                isPageView(event) &&
                event.body.session.id === renewedContext.session.id &&
                event.body.view.id === firstView.view.id,
            }).length > 0
          );
        },
        { timeout: 15 * ONE_SECOND, message: 'Expected the open page view in the renewed session' }
      )
      .toBe(true);
  });
});

test('creates a new session on each app launch', async ({ intake }) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: Launch app and capture session ID
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const firstViewEvents = await intake.getEventsByType('view');
  const firstSessionId = firstViewEvents[0].body.session.id;
  await firstElectronApp.close();
  intake.clear();

  // Phase 2: Relaunch with the same userDataDir
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    const secondViewEvents = await intake.getEventsByType('view');
    const secondSessionId = secondViewEvents[0].body.session.id;

    expect(secondSessionId).toMatch(/^[0-9a-f-]+$/);
    expect(secondSessionId).not.toBe(firstSessionId);
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});
