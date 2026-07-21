import type { RumErrorEvent } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

test.use({ beforeSendMode: 'scrub-and-filter' });

test('beforeSend scrubs and filters main and renderer RUM events', async ({ electronApp, intake, mainPage }) => {
  await mainPage.flushTransport();
  intake.clear();

  await mainPage.generateManualError(undefined, { beforeSend: 'scrub', secret: 'main secret' });
  await mainPage.generateManualError(undefined, { beforeSend: 'drop' });

  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  await bridgeWindow.generateError('beforeSend renderer secret');
  await bridgeWindow.generateError('beforeSend renderer drop');
  await mainPage.flushTransport();

  const errorEvents = await intake.waitForEventCount('error', 2);
  const errors = errorEvents.map(({ body }) => body as RumErrorEvent);

  expect(errors).toHaveLength(2);
  expect(errors.map(({ error }) => error.message)).toEqual(
    expect.arrayContaining(['redacted main error', 'redacted renderer error'])
  );
  expect(errors.find(({ error }) => error.message === 'redacted main error')?.context).toEqual({
    secret: '[REDACTED]',
  });
});
