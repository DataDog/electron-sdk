import { test, expect } from '../lib/helpers';
import type { RumActionEvent, RumViewEvent } from '@datadog/electron-sdk';

test('emits a custom action event attached to the main-process view', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const view = viewEvents[0].body as RumViewEvent;

  await mainPage.addAction('checkout_submitted', { cartId: 'abc' });
  await mainPage.flushTransport();

  const actionEvents = await intake.waitForEventCount('action', 1);
  const action = actionEvents[0].body as RumActionEvent;

  expect(action.type).toBe('action');
  expect(action.action.type).toBe('custom');
  expect(action.action.target?.name).toBe('checkout_submitted');
  expect(action.action.id).toBeDefined();
  expect((action as { context?: Record<string, unknown> }).context).toMatchObject({ cartId: 'abc' });

  // Common RUM context is populated by the main-process Assembly pipeline.
  expect(action.session.id).toBe(view.session.id);
  expect(action.application.id).toBe(view.application.id);
  expect(action.view.id).toBe(view.view.id);
  expect(action.source).toBe('electron');
  expect(action._dd.format_version).toBe(2);
  expect(typeof action.date).toBe('number');
  expect(action.date).toBeGreaterThan(0);
});

test('emits one custom action per call, preserving the given names', async ({ mainPage, intake }) => {
  await mainPage.addAction('first');
  await mainPage.addAction('second');
  await mainPage.flushTransport();

  const actions = (await intake.waitForEventCount('action', 2)).map((e) => e.body as RumActionEvent);
  expect(actions.map((a) => a.action.target?.name).sort()).toEqual(['first', 'second']);
});
