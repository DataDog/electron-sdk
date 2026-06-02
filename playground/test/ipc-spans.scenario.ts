import type { Page } from '@playwright/test';
import { test, expect, flushTransport } from './helpers';
import type { Intake, ReceivedEvent } from '../../e2e/lib/intake';

interface ViewContextBody {
  view: { id: string; url?: string };
  session: { id: string };
}

function isMainProcessView(e: ReceivedEvent): boolean {
  return (e.body as { view?: { url?: string } }).view?.url === 'electron://main-process';
}

async function getMainView(intake: Intake): Promise<ViewContextBody> {
  const events = await intake.waitForEventCount('view', 1, { timeout: 10_000, predicate: isMainProcessView });
  return events[0].body as ViewContextBody;
}

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
  const mainView = await getMainView(intake);

  await window.click('#demo-get-data');
  await flushTransport(window);

  const mainSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.handle' && s.resource === 'demo:get-data',
    {
      timeout: 10_000,
    }
  );

  expect(mainSpan.service).toBeTruthy();
  expect(mainSpan.trace_id).toBeTruthy();
  expect(mainSpan.meta['_dd.view.id']).toBe(mainView.view.id);
  expect(mainSpan.meta['_dd.session.id']).toBe(mainView.session.id);
});

test('renderer→main: ipcRenderer.invoke creates linked spans', async ({ window, intake }) => {
  await waitForSession(window, intake);
  const mainView = await getMainView(intake);
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

  // renderer span carries renderer process view id (distinct from main process view)
  expect(rendererSpan.meta['_dd.view.id']).toBeTruthy();
  expect(rendererSpan.meta['_dd.view.id']).not.toBe(mainSpan.meta['_dd.view.id']);
  // renderer and main spans share the same session
  expect(rendererSpan.meta['_dd.session.id']).toBe(mainSpan.meta['_dd.session.id']);
  // main span carries main process view id and session id
  expect(mainSpan.meta['_dd.view.id']).toBe(mainView.view.id);
  expect(mainSpan.meta['_dd.session.id']).toBe(mainView.session.id);
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
  const mainSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.handle' && s.resource === 'demo:get-data',
    { timeout: 5_000 }
  );

  const spanActionId = rendererSpan.meta?.['_dd.action.id'];

  // renderer span carries a distinct renderer process view id, not the main process one
  expect(rendererSpan.meta?.['_dd.view.id']).toBeTruthy();
  expect(rendererSpan.meta?.['_dd.view.id']).not.toBe(mainSpan.meta['_dd.view.id']);
  // renderer span carries the action id matching the RUM click action from the intake
  expect(spanActionId).toBeTruthy();
  const [matchingAction] = await intake.waitForEventCount('action', 1, {
    timeout: 10_000,
    predicate: (e) => (e.body as { action?: { id?: string } }).action?.id === spanActionId,
  });
  expect((matchingAction.body as { action?: { id?: string } }).action?.id).toBe(spanActionId);
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

  // Wait for the renderer to process the push notification (the onPushNotification callback
  // fires synchronously before reportSpan sends RENDERER_SPAN_CHANNEL to main).
  // This guarantees the renderer.receive IPC is in-flight before the next flush.
  await window.waitForSelector('.log-channel:text("demo:push-notification")', { timeout: 5_000 });
  await flushTransport(window);

  const rendererReceiveSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.renderer.receive' && s.resource === 'demo:push-notification',
    { timeout: 5_000 }
  );

  expect(rendererReceiveSpan.trace_id).toBe(mainSendSpan.trace_id);
  expect(rendererReceiveSpan.parent_id).toBe(mainSendSpan.span_id);
});
