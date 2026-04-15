import { test, expect, flushTransport } from './helpers';
import type { RumViewEvent, RumErrorEvent } from '@datadog/electron-sdk';

test('renderer process is detected as a view', async ({ window, intake }) => {
  // The main window renderer should already be detected by the poll (2s interval)
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);
  const rendererView = viewEvents.find((e) => ((e.body as RumViewEvent).view.name ?? '').startsWith('Renderer:'));

  expect(rendererView).toBeDefined();
  const body = rendererView!.body as RumViewEvent;
  expect(body.view.id).toBeDefined();
  expect(body.view.is_active).toBe(true);
});

test('renderer process view starts before or at the same time as browser-rum view', async ({ window, intake }) => {
  await window.waitForTimeout(3000);
  await flushTransport(window);

  const viewEvents = await intake.getEventsByType('view', 10_000);

  // Find the renderer process view (emitted by RendererProcessCollection)
  const rendererProcessView = viewEvents.find((e) =>
    ((e.body as RumViewEvent).view.name ?? '').startsWith('Renderer:')
  );
  // Find the browser-rum view (emitted by browser-rum in the renderer, has source: 'browser')
  const browserRumView = viewEvents.find((e) => (e.body as RumViewEvent & { source?: string }).source === 'browser');

  expect(rendererProcessView).toBeDefined();
  expect(browserRumView).toBeDefined();

  const rendererDate = (rendererProcessView!.body as RumViewEvent).date;
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
