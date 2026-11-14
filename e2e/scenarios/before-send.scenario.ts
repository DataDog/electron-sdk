import type { InitConfiguration } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

interface E2EControls {
  beforeSendRum: NonNullable<InitConfiguration['beforeSendRum']>;
}

test.use({ beforeSendRumEnabled: true });

test('scrubs main-process RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSendRum = (event, { source }) => {
      if (source === 'main' && event.type === 'error') {
        event.error.message = 'redacted main error';
        event.context = { ...event.context, secret: '[REDACTED]' };
      }
      return true;
    };
  });
  await mainPage.flushTransport();
  intake.clear();

  await mainPage.generateManualError(undefined, { secret: 'main secret' });
  await mainPage.flushTransport();

  const errorEvents = await intake.waitForEventCount('error', 1);
  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].body).toMatchObject({
    error: { message: 'redacted main error' },
    context: { secret: '[REDACTED]' },
  });
});

test('filters main-process RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSendRum = (event, { source }) =>
      source !== 'main' || event.type !== 'error';
  });
  await mainPage.flushTransport();
  intake.clear();

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('error');
});

test('filters renderer RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSendRum = (event, { source }) =>
      source !== 'renderer' || event.type !== 'error';
  });
  await mainPage.flushTransport();
  intake.clear();

  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  await bridgeWindow.generateError('beforeSend renderer error');
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('error');
});

test('drops an oversized RUM event without losing the next event', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSendRum = (event) => {
      if (event.type === 'error' && event.context?.size === 'oversized') {
        const large = 'é'.repeat(200_000);
        event.context = { huge: large };
        event.error.message = large;
        event.error.stack = large;
      }
      return true;
    };
  });
  await mainPage.generateManualError(undefined, { size: 'oversized' });
  await mainPage.generateManualError(undefined, { size: 'normal' });
  await mainPage.flushTransport();
  const errors = await intake.getEventsByType('error');
  expect(errors.map(({ body }) => body.context)).toEqual([{ size: 'normal' }]);
});
