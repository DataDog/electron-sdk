import { test, expect } from '../lib/helpers';

interface ExecutionContextEvent {
  type: 'execution_context';
  execution_context: {
    id: string;
    type: 'main-process' | 'renderer-process';
    pid: number;
    name?: string;
    duration?: number;
    exit_reason?: string;
  };
  _dd: { document_version: number };
}

test('emits a main execution context start event on SDK init', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const events = await intake.getEventsByType('execution_context');

  expect(events.length).toBeGreaterThanOrEqual(1);
  const mainEvent = events.find((e) => (e.body as ExecutionContextEvent).execution_context.type === 'main-process');
  expect(mainEvent).toBeDefined();

  const body = mainEvent!.body as ExecutionContextEvent;
  expect(body.execution_context.type).toBe('main-process');
  expect(body.execution_context.pid).toBeGreaterThan(0);
  expect(body._dd.document_version).toBe(1);
  expect(body.execution_context.duration).toBeUndefined();
  expect(body.execution_context.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
});

test('all main-process events carry execution_context.id and execution_context.type', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  expect(viewEvents.length).toBeGreaterThanOrEqual(1);

  const view = viewEvents[0].body as Record<string, unknown>;
  const executionContext = view['execution_context'] as { id: string; type: string } | undefined;
  expect(executionContext).toBeDefined();
  expect(executionContext!.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  expect(executionContext!.type).toBe('main-process');
});

test('emits start and end execution_context events for a renderer window lifecycle', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const before = (await intake.getEventsByType('execution_context')).length;

  await mainPage.openRendererProcess();
  await mainPage.flushTransport();

  const afterOpen = await intake.getEventsByType('execution_context');
  const rendererStart = afterOpen
    .slice(before)
    .find((e) => (e.body as ExecutionContextEvent).execution_context.type === 'renderer-process');
  expect(rendererStart).toBeDefined();

  const body = rendererStart!.body as ExecutionContextEvent;
  expect(body._dd.document_version).toBe(1);
  expect(body.execution_context.duration).toBeUndefined();
  const rendererId = body.execution_context.id;

  await mainPage.closeRendererProcess();
  await mainPage.flushTransport();

  const afterClose = await intake.getEventsByType('execution_context');
  const rendererEnd = afterClose
    .slice(afterOpen.length)
    .find((e) => (e.body as ExecutionContextEvent).execution_context.id === rendererId);
  expect(rendererEnd).toBeDefined();
  expect((rendererEnd!.body as ExecutionContextEvent)._dd.document_version).toBeGreaterThan(1);
});
