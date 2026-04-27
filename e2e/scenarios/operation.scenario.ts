import { test, expect } from '../lib/helpers';
import type { RumViewEvent, RumVitalOperationStepEvent } from '@datadog/electron-sdk';

test('emits start and succeed vital operation_step events', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.startFeatureOperation('checkout');
  await mainPage.succeedFeatureOperation('checkout');
  await mainPage.flushTransport();

  const vitalEvents = await intake.waitForEventCount('vital', 2);
  expect(vitalEvents).toHaveLength(2);

  const vitals = vitalEvents.map((e) => e.body as RumVitalOperationStepEvent);
  const start = vitals.find((v) => v.vital?.step_type === 'start')!;
  const end = vitals.find((v) => v.vital?.step_type === 'end')!;
  expect(start).toBeDefined();
  expect(end).toBeDefined();

  expect(start.type).toBe('vital');
  expect(start.vital?.type).toBe('operation_step');
  expect(start.vital?.name).toBe('checkout');
  expect(start.vital?.failure_reason).toBeUndefined();
  expect(start.vital?.operation_key).toBeUndefined();

  expect(end.vital?.failure_reason).toBeUndefined();
  expect(end.vital?.name).toBe('checkout');
  expect(end.vital?.id).not.toBe(start.vital?.id);

  // Common RUM context is populated by the main-process Assembly pipeline.
  expect(start.session.id).toBe(view.session.id);
  expect(end.session.id).toBe(view.session.id);
  expect(start.application.id).toBe(view.application.id);
  expect(start.view.id).toBe(view.view.id);
  expect(end.view.id).toBe(view.view.id);
  expect(start.source).toBe('electron');
  expect(start._dd.format_version).toBe(2);
  expect(typeof start.date).toBe('number');
  expect(start.date).toBeGreaterThan(0);
});

test('emits start and fail vital operation_step events with failure_reason', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();

  await mainPage.startFeatureOperation('checkout');
  await mainPage.failFeatureOperation('checkout', 'error');
  await mainPage.flushTransport();

  const vitals = (await intake.waitForEventCount('vital', 2)).map((e) => e.body as RumVitalOperationStepEvent);
  const start = vitals.find((v) => v.vital?.step_type === 'start')!;
  const fail = vitals.find((v) => v.vital?.step_type === 'end')!;

  expect(start.vital?.failure_reason).toBeUndefined();
  expect(fail.vital?.failure_reason).toBe('error');
  expect(fail.vital?.id).not.toBe(start.vital?.id);
});

test('forwards operationKey to the event payload on both start and end', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();

  await mainPage.startFeatureOperation('upload', { operationKey: 'photo_1' });
  await mainPage.succeedFeatureOperation('upload', { operationKey: 'photo_1' });
  await mainPage.flushTransport();

  const vitals = (await intake.waitForEventCount('vital', 2)).map((e) => e.body as RumVitalOperationStepEvent);
  for (const v of vitals) {
    expect(v.vital?.operation_key).toBe('photo_1');
    expect(v.vital?.name).toBe('upload');
  }
});

test('omits operation_key when the operation is unkeyed', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();

  await mainPage.startFeatureOperation('login');
  await mainPage.flushTransport();

  const vitalEvents = await intake.waitForEventCount('vital', 1);
  const start = vitalEvents[0].body as RumVitalOperationStepEvent;

  expect(start.vital?.operation_key).toBeUndefined();
});

test('stop without prior start still emits the event (no local tracking)', async ({ mainPage, intake }) => {
  // Electron intentionally does not track active operations locally; renderer
  // start/stop events bridged via DatadogEventBridge would desync any main-side
  // tracking. The main-process API therefore emits unconditionally.
  await mainPage.flushTransport();

  await mainPage.succeedFeatureOperation('dangling');
  await mainPage.flushTransport();

  const vitalEvents = await intake.waitForEventCount('vital', 1);
  expect(vitalEvents).toHaveLength(1);

  const end = vitalEvents[0].body as RumVitalOperationStepEvent;
  expect(end.vital?.step_type).toBe('end');
  expect(end.vital?.name).toBe('dangling');
});
