import { test, expect } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

test('attributes event to correct session and view based on startTime', async ({ app, intake }) => {
  await app.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const firstView = viewEvents[0].body as RumViewEvent;
  const firstSessionId = firstView.session.id;
  const firstViewId = firstView.view.id;

  // Record timestamp while first session is active
  const timestampInFirstSession = Date.now();

  // Renew session (stop + activity)
  await app.renewSession();

  // Add error with timestamp from first session
  await app.generateManualError(timestampInFirstSession);
  await app.flushTransport();

  // Verify error is attributed to first session/view
  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body as RumErrorEvent;
  expect(error.session.id).toBe(firstSessionId);
  expect(error.view.id).toBe(firstViewId);
  expect(error.date).toBe(timestampInFirstSession);
});

test('events should not be sent when the session is expired', async ({ app, intake }) => {
  await app.flushTransport();
  await app.stopSession();

  await app.generateManualError();
  await app.flushTransport();

  await intake.assertNoNewEvents('error');
});
