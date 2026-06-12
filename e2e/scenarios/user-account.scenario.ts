import { test, expect } from '../lib/helpers';
import type { RumErrorEvent } from '@datadog/electron-sdk';

test('attaches user info to subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });
});

test('does not attach usr when no user is set', async ({ mainPage, intake }) => {
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toBeUndefined();
});

test('clears user info from subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1' });
  await mainPage.clearUserInfo();
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toBeUndefined();
});

test('updates user info via property setter', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });
  await mainPage.setUserInfoProperty('name', 'Bob');
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toMatchObject({ id: 'user-1', name: 'Bob' });
});

test('removes a user property', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });
  await mainPage.removeUserInfoProperty('name');
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toMatchObject({ id: 'user-1' });
  expect((error.usr as Record<string, unknown>).name).toBeUndefined();
});

test('attaches account info to subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.account).toEqual({ id: 'account-1', name: 'Acme Corp' });
});

test('clears account info from subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setAccountInfo({ id: 'account-1' });
  await mainPage.clearAccountInfo();
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.account).toBeUndefined();
});

test('attaches both user and account info to the same event', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice' });
  expect(error.account).toEqual({ id: 'account-1', name: 'Acme Corp' });
});

test('spreads extraInfo fields into usr at the top level', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', extraInfo: { plan: 'premium', org: 'acme' } });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toMatchObject({ id: 'user-1', plan: 'premium', org: 'acme' });
  expect((error.usr as Record<string, unknown>).extraInfo).toBeUndefined();
});
