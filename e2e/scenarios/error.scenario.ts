import { test, expect } from '../lib/helpers';
import type { RumErrorEvent, RumViewEvent } from '@datadog/electron-sdk';

test('emits an error event on uncaught exception', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.generateUncaughtException();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.error.message).toBe('test uncaught exception');
  expect(error.error.source).toBe('source');
  expect(error.error.handling).toBe('unhandled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(view.session.id);
  expect(error.view.id).toBe(view.view.id);
});

test('emits an error event on manual addError call', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.error.message).toBe('test manual error');
  expect(error.error.source).toBe('custom');
  expect(error.error.handling).toBe('handled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(view.session.id);
  expect(error.view.id).toBe(view.view.id);
  expect(error.context).toEqual({ foo: 'bar' });
});

test('emits an error event on unhandled rejection', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.generateUnhandledRejection();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents).toHaveLength(1);

  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.error.message).toBe('test unhandled rejection');
  expect(error.error.source).toBe('source');
  expect(error.error.handling).toBe('unhandled');
  expect(error.error.type).toBe('Error');
  expect(error.error.stack).toBeDefined();
  expect(error.error.id).toBeDefined();
  expect(error.session.id).toBe(view.session.id);
  expect(error.view.id).toBe(view.view.id);
});
