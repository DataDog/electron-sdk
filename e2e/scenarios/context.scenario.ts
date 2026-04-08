import { test, expect } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

const isMainProcessView = (event: { body: unknown }) =>
  (event.body as RumViewEvent).view.url === 'electron://main-process';

test.describe('event attribution with session renewal', () => {
  test.use({ rumBrowserSdk: {} });

  test('attributes event to correct session and view based on startTime', async ({ mainPage, intake }) => {
    await mainPage.flushTransport();
    const viewEvents = await intake.getEventsByType('view');
    const firstView = viewEvents.find(isMainProcessView)!.body as RumViewEvent;
    const firstSessionId = firstView.session.id;
    const firstViewId = firstView.view.id;

    // Record timestamp while first session is active
    const timestampInFirstSession = Date.now();

    // Renew session (stop + activity)
    await mainPage.renewSession();

    // Add error with timestamp from first session
    await mainPage.generateManualError(timestampInFirstSession);
    await mainPage.flushTransport();

    // Verify error is attributed to first session/view
    const errorEvents = await intake.getEventsByType('error');
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body as RumErrorEvent;
    expect(error.session.id).toBe(firstSessionId);
    expect(error.view.id).toBe(firstViewId);
    expect(error.date).toBe(timestampInFirstSession);
  });
});

test('events should not be sent when the session is expired', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await mainPage.stopSession();

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(0);
});
