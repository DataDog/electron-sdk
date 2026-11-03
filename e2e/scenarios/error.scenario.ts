import { test, expect } from '../lib/helpers';
import { isMainProcessEvent } from '../lib/intake';

test('emits an error event on uncaught exception', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  await mainPage.generateUncaughtException();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body;

  expect(error.error.message).toBe('test uncaught exception');
  expect(error.error.source).toBe('source');
  expect(error.error.handling).toBe('unhandled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  // The app path is scrubbed to `/`: main-process frames are root-relative, matching uploaded source maps.
  expect(error.error.stack).toMatch(/\(\/main\.js:\d+:\d+\)/);
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(mainContext.session.id);
  expect(error.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
});

test('emits an error event on manual addError call', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body;

  expect(error.error.message).toBe('test manual error');
  expect(error.error.source).toBe('custom');
  expect(error.error.handling).toBe('handled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(mainContext.session.id);
  expect(error.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
  expect(error.context).toEqual({ foo: 'bar' });
});

test('emits an error event on unhandled rejection', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const [{ body: mainContext }] = await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });

  await mainPage.generateUnhandledRejection();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body;

  expect(error.error.message).toBe('test unhandled rejection');
  expect(error.error.source).toBe('source');
  expect(error.error.handling).toBe('unhandled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(mainContext.session.id);
  expect(error.execution_context).toMatchObject({ id: mainContext.execution_context.id, type: 'main-process' });
});
