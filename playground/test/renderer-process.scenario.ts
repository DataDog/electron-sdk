import { test, expect, flushTransport } from './helpers';
import type { RumViewEvent, RumErrorEvent } from '@datadog/electron-sdk';

test('renderer process view has page title', async ({ window, intake }) => {
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);
  const rendererView = viewEvents.find((e) => ((e.body as RumViewEvent).view.name ?? '').startsWith('Renderer:'));

  expect(rendererView).toBeDefined();
  const body = rendererView!.body as RumViewEvent;
  expect(body.view.id).toBeDefined();
  expect(body.view.is_active).toBe(true);
  expect(body.view.name).toContain('Electron SDK Playground');
});

test('browser-rum view URL is sanitized', async ({ window, intake }) => {
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);
  const browserRumView = viewEvents.find((e) => (e.body as RumViewEvent & { source?: string }).source === 'browser');

  expect(browserRumView).toBeDefined();
  const browserBody = browserRumView!.body as RumViewEvent;
  expect(browserBody.view.url).toBeDefined();
  expect(browserBody.view.url).toContain('[APP_PATH]');
  expect(browserBody.view.url).not.toContain('/Users/');
});

test('renderer process view starts before or at the same time as browser-rum view', async ({ window, intake }) => {
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);

  // Find the latest renderer process view update (highest document version has the corrected date)
  const rendererProcessViews = viewEvents.filter((e) =>
    ((e.body as RumViewEvent).view.name ?? '').startsWith('Renderer:')
  );
  // Find the browser-rum view (emitted by browser-rum in the renderer, has source: 'browser')
  const browserRumView = viewEvents.find((e) => (e.body as RumViewEvent & { source?: string }).source === 'browser');

  expect(rendererProcessViews.length).toBeGreaterThanOrEqual(1);
  expect(browserRumView).toBeDefined();

  // Use the latest view update — it has the most accurate (backdated) startTime
  const latestRendererView = rendererProcessViews[rendererProcessViews.length - 1];
  const rendererDate = (latestRendererView.body as RumViewEvent).date;
  const browserDate = (browserRumView!.body as RumViewEvent).date;
  expect(rendererDate).toBeLessThanOrEqual(browserDate);
});

test('crash renderer produces an error on renderer view', async ({ window, intake }) => {
  await window.click('#crash-renderer');
  // Wait for: 3s delay in handler before crash + 2s for events to propagate
  await window.waitForTimeout(6000);
  await flushTransport(window);

  const errorEvents = await intake.getEventsByType('error', 10_000);
  const rendererError = errorEvents.find((e) =>
    ((e.body as RumErrorEvent).error.message ?? '').includes('Renderer process')
  );

  expect(rendererError).toBeDefined();
  const body = rendererError!.body as RumErrorEvent;
  expect(body.error.source).toBe('source');
  expect(body.error.handling).toBe('unhandled');
});
