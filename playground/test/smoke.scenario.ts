import { test, expect, flushTransport } from './helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';

test('app launches and a view event arrives at intake', async ({ window, intake }) => {
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);

  expect(viewEvents.length).toBeGreaterThanOrEqual(1);

  const body = viewEvents[0].body as RumViewEvent;
  expect(body.type).toBe('view');
  expect(body.view.id).toBeDefined();
  expect(body.application.id).toBeDefined();
  expect(body.session.id).toBeDefined();
});
