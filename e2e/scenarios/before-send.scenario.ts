import type { RumErrorEvent } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

test.use({ beforeSendMode: 'scrub-and-filter' });

test('beforeSend only scrubs and filters main-process RUM events', async ({ electronApp, intake, mainPage }) => {
  await mainPage.flushTransport();
  intake.clear();

  await mainPage.generateManualError(undefined, { beforeSend: 'scrub', secret: 'main secret' });
  await mainPage.generateManualError(undefined, { beforeSend: 'drop' });

  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  await bridgeWindow.generateError('beforeSend renderer secret');
  await bridgeWindow.generateError('beforeSend renderer drop');
  await mainPage.flushTransport();

  const errorEvents = await intake.waitForEventCount('error', 3);
  const errors = errorEvents.map(({ body }) => body as RumErrorEvent);

  expect(errors.map(({ error }) => error.message)).toEqual(
    expect.arrayContaining(['redacted main error', 'beforeSend renderer secret', 'beforeSend renderer drop'])
  );
  expect(errors.find(({ error }) => error.message === 'redacted main error')?.context).toEqual({
    secret: '[REDACTED]',
  });
});
