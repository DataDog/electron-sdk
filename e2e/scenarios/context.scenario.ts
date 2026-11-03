import { test, expect } from '../lib/helpers';
import { isMainProcessEvent } from '../lib/intake';

test.describe('event attribution with session renewal', () => {
  test.use({ rumBrowserSdk: {} });

  test('attributes event to correct session and execution context based on startTime', async ({ mainPage, intake }) => {
    await mainPage.flushTransport();
    const [{ body: firstContext }] = await intake.getEventsByType('execution_context', {
      predicate: isMainProcessEvent,
    });
    const firstSessionId = firstContext.session.id;
    const firstExecutionContextId = firstContext.execution_context.id;

    // Record timestamp while first session is active
    const timestampInFirstSession = Date.now();

    // Renew session (stop + activity)
    await mainPage.renewSession();

    // Add error with timestamp from first session
    await mainPage.generateManualError(timestampInFirstSession);
    await mainPage.flushTransport();

    // Verify error is attributed to first session/execution context
    const errorEvents = await intake.getEventsByType('error');
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body;
    expect(error.session.id).toBe(firstSessionId);
    expect(error.execution_context).toMatchObject({ id: firstExecutionContextId, type: 'main-process' });
    expect(error.date).toBe(timestampInFirstSession);
  });
});

test('events should not be sent when the session is expired', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  await mainPage.stopSession();

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('error');
});
