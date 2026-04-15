import { test, expect, flushTransport } from './helpers';
import type { RumViewEvent, RumErrorEvent } from '@datadog/electron-sdk';

test('fork utility produces a view event', async ({ window, intake }) => {
  await window.click('#fork-utility');
  await window.waitForTimeout(2000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);
  const utilityView = viewEvents.find((e) => ((e.body as RumViewEvent).view.name ?? '').includes('Utility:'));

  expect(utilityView).toBeDefined();
  const body = utilityView!.body as RumViewEvent;
  expect(body.view.name).toContain('dd-demo-worker');
  expect(body.view.id).toBeDefined();
});

test('crash utility produces an error event linked to utility view', async ({ window, intake }) => {
  await window.click('#crash-utility');
  await window.waitForTimeout(3000);
  await flushTransport(window);

  // Wait for error event first — it proves the crash was processed
  const errorEvents = await intake.getEventsByType('error', 10_000);
  const processError = errorEvents.find((e) =>
    ((e.body as RumErrorEvent).error.message ?? '').includes('dd-demo-crash-worker')
  );

  expect(processError).toBeDefined();
  const errorBody = processError!.body as RumErrorEvent;
  expect(errorBody.error.source).toBe('source');
  expect(errorBody.error.handling).toBe('unhandled');

  // Find the final view update (is_active: false) which should have the error count
  const viewEvents = await intake.getEventsByType('view', 10_000);
  const finalView = viewEvents.find(
    (e) =>
      ((e.body as RumViewEvent).view.name ?? '').includes('dd-demo-crash-worker') &&
      !(e.body as RumViewEvent).view.is_active
  );

  expect(finalView).toBeDefined();
  const viewBody = finalView!.body as RumViewEvent;
  expect(viewBody.view.error.count).toBeGreaterThanOrEqual(1);
});
