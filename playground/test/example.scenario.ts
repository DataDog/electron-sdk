import { test, expect, flushTransport } from './helpers';

test('playground sends events to the intake', async ({ window, intake }) => {
  // Generate SDK activity to produce events
  await window.click('#generate-activity');
  await flushTransport(window);

  const events = await intake.getEventsByType('view');
  expect(events.length).toBeGreaterThan(0);
});
