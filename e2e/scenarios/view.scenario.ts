import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';

const isMainProcessView = (event: { body: unknown }) =>
  (event.body as RumViewEvent).view.url === 'electron://main-process';

test('emits an initial active view event on SDK init', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const events = await intake.getEventsByType('view');
  expect(events).toHaveLength(1);

  const {
    body: view,
    headers,
    ddforward,
  } = events[0] as {
    body: RumViewEvent;
    headers: Record<string, string>;
    ddforward: string;
  };

  expect(view.ddtags).toMatch(/sdk_version:\d+\.\d+\.\d+/);
  expect(view.ddtags).toContain('env:test');
  expect(view.ddtags).toContain('service:e2e-test-app');
  expect(view.ddtags).toContain('version:1.0.0');
  expect(view.service).toBe('e2e-test-app');
  expect(view.version).toBe('1.0.0');
  expect(ddforward).toContain('/api/v2/rum');
  expect(ddforward).toContain('ddsource=electron');
  expect(headers['dd-evp-origin']).toBe('electron');
  expect(headers['dd-evp-origin-version']).toMatch(/^\d+\.\d+\.\d+$/);
  expect(headers['dd-request-id']).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
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

test.describe('session renewal via user activity', () => {
  test.use({ rumBrowserSdk: {} });

  test('emits an inactive view on session expiry and a new active view on session renewal', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    const initialEvents = await intake.getEventsByType('view');
    const initialViewId = (initialEvents.find(isMainProcessView)!.body as RumViewEvent).view.id;

    await mainPage.stopSession();
    await mainPage.flushTransport();

    const eventsAfterStop = await intake.waitForEventCount('view', 2, { predicate: isMainProcessView });
    const inactiveView = eventsAfterStop[1].body as RumViewEvent;

    expect(inactiveView.view.id).toBe(initialViewId);
    expect(inactiveView.view.is_active).toBe(false);
    expect(inactiveView._dd.document_version).toBe(2);

    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const eventsAfterRenewal = await intake.waitForEventCount('view', 3, { predicate: isMainProcessView });
    const newView = eventsAfterRenewal[2].body as RumViewEvent;

    expect(newView.view.id).not.toBe(initialViewId);
    expect(newView.view.is_active).toBe(true);
    expect(newView._dd.document_version).toBe(1);
  });
});

test('increments view error count after an uncaught exception', async ({ mainPage, intake }) => {
  await mainPage.generateUncaughtException();
  await mainPage.flushTransport();

  await intake.getEventsByType('error');
  const viewEvents = await intake.waitForEventCount('view', 2);
  const updatedView = viewEvents[1].body as RumViewEvent;

  expect(updatedView.view.error.count).toBe(1);
  expect(updatedView._dd.document_version).toBeGreaterThan(1);
});
