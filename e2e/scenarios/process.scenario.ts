import { test, expect } from '../lib/helpers';

interface ProcessEvent {
  type: 'process';
  process: {
    id: string;
    role: 'main' | 'renderer';
    pid: number;
    name?: string;
    duration?: number;
    exit_reason?: string;
  };
  _dd: { document_version: number };
}

test('emits a main process start event on SDK init', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const events = await intake.getEventsByType('process');

  expect(events.length).toBeGreaterThanOrEqual(1);
  const mainEvent = events.find((e) => (e.body as ProcessEvent).process.role === 'main');
  expect(mainEvent).toBeDefined();

  const body = mainEvent!.body as ProcessEvent;
  expect(body.process.role).toBe('main');
  expect(body.process.pid).toBeGreaterThan(0);
  expect(body._dd.document_version).toBe(1);
  expect(body.process.duration).toBeUndefined();
  expect(body.process.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('all main-process events carry process.id and process.role', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  expect(viewEvents.length).toBeGreaterThanOrEqual(1);

  const view = viewEvents[0].body as Record<string, unknown>;
  const processCtx = view['process'] as { id: string; role: string } | undefined;
  expect(processCtx).toBeDefined();
  expect(processCtx!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(processCtx!.role).toBe('main');
});

test('emits start and end process events for a renderer window lifecycle', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const before = (await intake.getEventsByType('process')).length;

  await mainPage.openRendererProcess();
  await mainPage.flushTransport();

  const afterOpen = await intake.getEventsByType('process');
  const rendererStart = afterOpen.slice(before).find((e) => (e.body as ProcessEvent).process.role === 'renderer');
  expect(rendererStart).toBeDefined();

  const body = rendererStart!.body as ProcessEvent;
  expect(body._dd.document_version).toBe(1);
  expect(body.process.duration).toBeUndefined();
  const rendererId = body.process.id;

  await mainPage.closeRendererProcess();
  await mainPage.flushTransport();

  const afterClose = await intake.getEventsByType('process');
  const rendererEnd = afterClose
    .slice(afterOpen.length)
    .find((e) => (e.body as ProcessEvent).process.id === rendererId);
  expect(rendererEnd).toBeDefined();
  expect((rendererEnd!.body as ProcessEvent)._dd.document_version).toBeGreaterThan(1);
});
