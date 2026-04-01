import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';

test('emits an initial active view event on SDK init', async ({ app, intake }) => {
  await app.flushTransport();
  const events = await intake.getEventsByType('view');
  expect(events).toHaveLength(1);

  const view = events[0].body as RumViewEvent;

  expect(view.ddtags).toMatch(/sdk_version:\d+\.\d+\.\d+/);
  expect(view.view.name).toBe('main process');
  expect(view.view.url).toBe('electron://main-process');
  expect(view.view.is_active).toBe(true);
  expect(view.view.action.count).toBe(0);
  expect(view.view.error.count).toBe(0);
  expect(view.view.resource.count).toBe(0);
  expect(view._dd.document_version).toBe(1);
  expect(view.view.id).toBeDefined();
  expect(view.view.time_spent).toBeGreaterThanOrEqual(0);
});

test('emits an inactive view on session expiry and a new active view on session renewal', async ({ app, intake }) => {
  await app.flushTransport();
  const initialEvents = await intake.getEventsByType('view');
  const initialViewId = (initialEvents[0].body as RumViewEvent).view.id;

  await app.stopSession();
  await app.flushTransport();

  const eventsAfterStop = await intake.waitForEventCount('view', 2);
  const inactiveView = eventsAfterStop[1].body as RumViewEvent;

  expect(inactiveView.view.id).toBe(initialViewId);
  expect(inactiveView.view.is_active).toBe(false);
  expect(inactiveView._dd.document_version).toBe(2);

  await app.generateActivity();
  await app.flushTransport();

  const eventsAfterRenewal = await intake.waitForEventCount('view', 3);
  const newView = eventsAfterRenewal[2].body as RumViewEvent;

  expect(newView.view.id).not.toBe(initialViewId);
  expect(newView.view.is_active).toBe(true);
  expect(newView._dd.document_version).toBe(1);
});

test('increments view error count after an uncaught exception', async ({ app, intake }) => {
  await app.generateUncaughtException();
  await app.flushTransport();

  await intake.getEventsByType('error');
  const viewEvents = await intake.waitForEventCount('view', 2);
  const updatedView = viewEvents[1].body as RumViewEvent;

  expect(updatedView.view.error.count).toBe(1);
  expect(updatedView._dd.document_version).toBeGreaterThan(1);
});
