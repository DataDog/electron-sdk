import type { InitConfiguration } from '@datadog/electron-sdk';
import { test, expect } from '../lib/helpers';

test('drops a batch rejected with HTTP 413 and continues delivering later logs', async ({
  electronApp,
  mainPage,
  intake,
}) => {
  const bridge = await mainPage.openBridgeFileWindow(electronApp);
  intake.setLogsResponseStatus(413);
  const previousRequests = intake.getLogRequestCount();
  await bridge.generateLog('rejected log');
  await mainPage.flushTransport();
  expect(intake.getLogRequestCount()).toBe(previousRequests + 1);
  expect(intake.getLogs()).toEqual([]);

  intake.setLogsResponseStatus(202);
  await bridge.generateLog('later log');
  const logs = await mainPage.whileFlushing(() => intake.waitForLogCount(1));
  expect(logs.map(({ body }) => body.message)).toEqual(['later log']);
  await mainPage.flushTransport();
  expect(intake.getLogs()).toHaveLength(1);
  expect(intake.getLogRequestCount()).toBe(previousRequests + 2);
});

test.describe('oversized RUM events', () => {
  test.use({ beforeSendRumEnabled: true });

  test('drops an oversized event without losing the next event', async ({ electronApp, intake, mainPage }) => {
    await electronApp.evaluate(() => {
      (
        globalThis as unknown as { __ddE2E: { beforeSendRum: NonNullable<InitConfiguration['beforeSendRum']> } }
      ).__ddE2E.beforeSendRum = (event) => {
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
});
