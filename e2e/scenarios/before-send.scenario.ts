import type { MainRumEvent, RumErrorEvent } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

interface E2EControls {
  beforeSend: (event: MainRumEvent) => boolean;
}

test.use({ beforeSendEnabled: true });

test('scrubs main-process RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSend = (event) => {
      if (event.type === 'error') {
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
  expect(errorEvents[0].body as RumErrorEvent).toMatchObject({
    error: { message: 'redacted main error' },
    context: { secret: '[REDACTED]' },
  });
});

test('filters main-process RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSend = (event) => event.type !== 'error';
  });
  await mainPage.flushTransport();
  intake.clear();

  await mainPage.generateManualError();
  await mainPage.flushTransport();

  await intake.assertNoNewEvents('error');
});

test('does not filter renderer RUM events', async ({ electronApp, intake, mainPage }) => {
  await electronApp.evaluate(() => {
    (globalThis as unknown as { __ddE2E: E2EControls }).__ddE2E.beforeSend = (event) => event.type !== 'error';
  });
  await mainPage.flushTransport();
  intake.clear();

  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  await bridgeWindow.generateError('beforeSend renderer error');
  await mainPage.flushTransport();

  const errorEvents = await intake.waitForEventCount('error', 1);
  expect(errorEvents).toHaveLength(1);
  expect((errorEvents[0].body as RumErrorEvent).error.message).toBe('beforeSend renderer error');
});
