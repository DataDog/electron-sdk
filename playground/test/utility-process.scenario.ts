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
  expect(body.view.name).toContain('dd-demo-fork');
  expect(body.view.id).toBeDefined();
});

test('fork utility produces view updates with memory metrics', async ({ window, intake }) => {
  await window.click('#fork-utility');
  // Wait long enough for at least one metrics poll (2s interval)
  await window.waitForTimeout(4000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);
  // Find a view update that has memory fields (from metrics poll)
  const viewWithMemory = viewEvents.find((e) => {
    const body = e.body as RumViewEvent;
    return (body.view.name ?? '').includes('dd-demo-fork') && body.view.memory_average !== undefined;
  });

  expect(viewWithMemory).toBeDefined();
  const body = viewWithMemory!.body as RumViewEvent;
  expect(body.view.memory_average).toBeGreaterThan(0);
  expect(body.view.memory_max).toBeGreaterThan(0);
});

test('throw error in utility produces an error event with stack trace', async ({ window, intake }) => {
  await window.click('#throw-utility-error');
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const errorEvents = await intake.getEventsByType('error', 10_000);
  const thrownError = errorEvents.find((e) =>
    ((e.body as RumErrorEvent).error.message ?? '').includes('Uncaught error in utility process')
  );

  expect(thrownError).toBeDefined();
  const errorBody = thrownError!.body as RumErrorEvent;
  expect(errorBody.error.source).toBe('source');
  expect(errorBody.error.handling).toBe('unhandled');
  expect(errorBody.error.stack).toBeDefined();
  expect(errorBody.error.stack!.length).toBeGreaterThan(0);

  // Verify the error is linked to the utility process view
  const viewEvents = await intake.getEventsByType('view', 10_000);
  const utilityView = viewEvents.find(
    (e) =>
      ((e.body as RumViewEvent).view.name ?? '').includes('dd-demo-throw-worker') &&
      !(e.body as RumViewEvent).view.is_active
  );

  expect(utilityView).toBeDefined();
  const viewBody = utilityView!.body as RumViewEvent;
  expect(viewBody.view.error.count).toBeGreaterThanOrEqual(1);
  // Error should be linked to the same view
  expect(errorBody.view.id).toBe(viewBody.view.id);
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
