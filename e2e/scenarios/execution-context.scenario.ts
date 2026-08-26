import { test, expect } from '../lib/helpers';

test.use({ sdkConfigOverrides: { enableExecutionContext: true } });

interface ExecutionContextEvent {
  type: 'execution_context';
  execution_context: {
    id: string;
    type: 'main-process' | 'renderer-process';
    instance_id: string;
    duration?: number;
    exit_reason?: string;
  };
  _dd: { document_version: number };
}

function asExecutionContextEvent(body: unknown): ExecutionContextEvent {
  return body as ExecutionContextEvent;
}

test('emits a main execution context start event on SDK init', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const events = await intake.getEventsByType('execution_context');

  expect(events.length).toBeGreaterThanOrEqual(1);
  const mainEvent = events.find((e) => asExecutionContextEvent(e.body).execution_context.type === 'main-process');
  expect(mainEvent).toBeDefined();

  const body = asExecutionContextEvent(mainEvent!.body);
  expect(body.execution_context.instance_id).toMatch(/^\d+$/);
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
    .find((e) => asExecutionContextEvent(e.body).execution_context.type === 'renderer-process');
  expect(rendererStart).toBeDefined();

  const body = asExecutionContextEvent(rendererStart!.body);
  expect(body._dd.document_version).toBe(1);
  const rendererId = body.execution_context.id;

  await mainPage.closeRendererProcess();
  await mainPage.flushTransport();

  const afterClose = await intake.getEventsByType('execution_context');
  const rendererEnd = afterClose
    .slice(afterOpen.length)
    .find((e) => asExecutionContextEvent(e.body).execution_context.id === rendererId);
  expect(rendererEnd).toBeDefined();
  expect(asExecutionContextEvent(rendererEnd!.body)._dd.document_version).toBeGreaterThan(1);
});

test.describe('session renewal', () => {
  test.use({ rumBrowserSdk: {} });

  test('a single OS process across two sessions produces two distinct main execution_context.id, sharing one instance_id', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    const initial = (await intake.getEventsByType('execution_context')).find(
      (e) => asExecutionContextEvent(e.body).execution_context.type === 'main-process'
    )!;
    const initialBody = asExecutionContextEvent(initial.body);

    await mainPage.stopSession();
    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const afterRenewal = await intake.getEventsByType('execution_context');
    const renewed = afterRenewal
      .filter((e) => asExecutionContextEvent(e.body).execution_context.type === 'main-process')
      .find((e) => asExecutionContextEvent(e.body).execution_context.id !== initialBody.execution_context.id);

    expect(renewed).toBeDefined();
    const renewedBody = asExecutionContextEvent(renewed!.body);
    expect(renewedBody.execution_context.instance_id).toBe(initialBody.execution_context.instance_id);
    expect(renewedBody._dd.document_version).toBe(1);
  });

  test('the action that triggers a session renewal is tagged with the new execution_context, not the old one', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    // The main window's own webContents is tracked as a 'renderer-process' execution context too,
    // so pick the most recently started one (there may be more than one at this point).
    const initialRenderer = [...(await intake.getEventsByType('execution_context'))]
      .reverse()
      .find((e) => asExecutionContextEvent(e.body).execution_context.type === 'renderer-process')!;
    const initialRendererId = asExecutionContextEvent(initialRenderer.body).execution_context.id;

    await mainPage.stopSession();
    // The renewal-triggering click itself never reaches the intake as an 'action' event: the
    // browser SDK relays it only once its dead-click validation window elapses, by which point the
    // renewed view has already opened at a later startTime than the click's own pinned startTime,
    // so ViewContext's container.view tagging discards it. A second click, sent once the renewal
    // has completed, is a real renderer-sourced action tagged via ExecutionContextCollection's own
    // renderer hook, and demonstrates the rotation took effect.
    await mainPage.generateActivity();
    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const actionEvents = await intake.getEventsByType('action', { timeout: 15000 });
    const taggedAction = actionEvents[actionEvents.length - 1].body as {
      execution_context?: { id: string };
    };

    expect(taggedAction.execution_context).toBeDefined();
    expect(taggedAction.execution_context!.id).not.toBe(initialRendererId);
  });

  test('the fake view emitted on session renewal carries the new session id and cross-tags with the new main execution_context', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    const initialFakeView = [...(await intake.getEventsByType('view'))].reverse().find((e) => e.body.view.is_fake)!;
    const initialViewId = initialFakeView.body.view.id;
    const initialMainContext = (await intake.getEventsByType('execution_context')).find(
      (e) => asExecutionContextEvent(e.body).execution_context.type === 'main-process'
    )!;
    const initialMainContextId = asExecutionContextEvent(initialMainContext.body).execution_context.id;

    await mainPage.stopSession();
    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const renewedFakeView = [...(await intake.getEventsByType('view'))]
      .reverse()
      .find((e) => e.body.view.is_fake && e.body.view.id !== initialViewId)!;
    expect(renewedFakeView).toBeDefined();
    expect(renewedFakeView.body.view.is_active).toBe(true);
    expect(renewedFakeView.body._dd.document_version).toBe(1);

    const renewedMainContext = (await intake.getEventsByType('execution_context'))
      .filter((e) => asExecutionContextEvent(e.body).execution_context.type === 'main-process')
      .find((e) => asExecutionContextEvent(e.body).execution_context.id !== initialMainContextId)!;
    expect(renewedMainContext).toBeDefined();
    const renewedContextId = asExecutionContextEvent(renewedMainContext.body).execution_context.id;

    // Cross-tag, both directions: the new fake view carries the new execution_context.id, and the
    // new execution_context event carries the new fake view's own session id.
    const viewExecutionContext = (renewedFakeView.body as Record<string, unknown>)['execution_context'] as
      { id: string } | undefined;
    expect(viewExecutionContext?.id).toBe(renewedContextId);

    const contextViewTag = renewedMainContext.body['view'] as { id: string } | undefined;
    expect(contextViewTag?.id).toBe(renewedFakeView.body.view.id);
  });

  test('a renderer window keeps its instance_id but gets a new execution_context.id after session renewal', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    await mainPage.openRendererProcess();
    await mainPage.flushTransport();

    // The main window's own webContents is tracked as a 'renderer-process' execution context too,
    // so the events array can hold more than one at this point; pick the most recently started one
    // (the one just opened) rather than the first match.
    const initialRenderer = [...(await intake.getEventsByType('execution_context'))]
      .reverse()
      .find((e) => asExecutionContextEvent(e.body).execution_context.type === 'renderer-process')!;
    const initialBody = asExecutionContextEvent(initialRenderer.body);

    await mainPage.stopSession();
    await mainPage.generateActivity();
    await mainPage.flushTransport();

    const afterRenewal = await intake.getEventsByType('execution_context');
    const renewedRenderer = afterRenewal
      .filter((e) => asExecutionContextEvent(e.body).execution_context.type === 'renderer-process')
      .find((e) => {
        const executionContext = asExecutionContextEvent(e.body).execution_context;
        return (
          executionContext.instance_id === initialBody.execution_context.instance_id &&
          executionContext.id !== initialBody.execution_context.id
        );
      });

    expect(renewedRenderer).toBeDefined();
    const renewedBody = asExecutionContextEvent(renewedRenderer!.body);
    expect(renewedBody.execution_context.instance_id).toBe(initialBody.execution_context.instance_id);

    await mainPage.closeRendererProcess();
  });
});
