import type { Page } from '@playwright/test';
import { test, expect, flushTransport } from './helpers';
import type { Intake } from '../../e2e/lib/intake';

// Establish session/view before any span assertions — mirrors e2e/scenarios/span.scenario.ts.
// Without a view in the main-process ViewContext, SpanProcessor discards all spans.
async function waitForSession(window: Page, intake: Intake): Promise<void> {
  await flushTransport(window);
  await intake.getEventsByType('view', { timeout: 15_000 });
}

// Sanity check: verify the existing ipcMain instrumentation works before
// testing renderer-side spans. This should pass even before dd-trace changes.
test('sanity: ipcMain span is emitted for demo:get-data', async ({ window, intake }) => {
  await waitForSession(window, intake);

  await window.click('#demo-get-data');
  await flushTransport(window);

  const span = await intake.waitForSpan((s) => s.name === 'electron.main.handle' && s.resource === 'demo:get-data', {
    timeout: 10_000,
  });

  expect(span.service).toBeTruthy();
  expect(span.trace_id).toBeTruthy();
});

test('renderer→main: ipcRenderer.invoke creates linked spans', async ({ window, intake }) => {
  await waitForSession(window, intake);
  intake.clear();

  await window.click('#demo-get-data');
  await flushTransport(window);

  const rendererSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.renderer.invoke' && s.resource === 'demo:get-data',
    { timeout: 10_000 }
  );
  const mainSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.handle' && s.resource === 'demo:get-data',
    { timeout: 5_000 }
  );

  expect(rendererSpan.trace_id).toBe(mainSpan.trace_id);
  expect(mainSpan.parent_id).toBe(rendererSpan.span_id);
});

test('renderer span carries RUM view context', async ({ window, intake }) => {
  await waitForSession(window, intake);
  intake.clear();

  await window.click('#demo-get-data');
  await flushTransport(window);

  const rendererSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.renderer.invoke' && s.resource === 'demo:get-data',
    { timeout: 10_000 }
  );

  expect(rendererSpan.meta?.['_dd.view.id']).toBeTruthy();
});

test('main→renderer: webContents.send creates linked spans', async ({ window, intake }) => {
  await waitForSession(window, intake);
  intake.clear();

  await window.click('#demo-trigger-push');
  await flushTransport(window);

  const mainSendSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.send' && s.resource === 'demo:push-notification',
    { timeout: 10_000 }
  );
  const rendererReceiveSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.renderer.receive' && s.resource === 'demo:push-notification',
    { timeout: 5_000 }
  );

  expect(rendererReceiveSpan.trace_id).toBe(mainSendSpan.trace_id);
  expect(rendererReceiveSpan.parent_id).toBe(mainSendSpan.span_id);
});
