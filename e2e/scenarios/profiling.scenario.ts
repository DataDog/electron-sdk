import { test, expect } from '../lib/helpers';

test.use({ rumBrowserSdk: {} });

test('browser SDK profiler flushes through bridge and reaches profiling intake', async ({
  electronApp,
  mainPage,
  intake,
}) => {
  await mainPage.flushTransport();

  const bridgeWindowPage = await mainPage.openBridgeHttpWindow(electronApp);

  // Generate a long task so the profiler emits the profile even with short duration
  // (profiles < 5s are only sent when they contain long tasks)
  await bridgeWindowPage.generateLongTask(500);

  // Close the window to trigger beforeunload, which flushes the profiling buffer
  await bridgeWindowPage.triggerProfilingFlush();

  // Wait for IPC propagation and profile write to complete before flushing
  await mainPage.flushTransport();

  const profilingRequests = await intake.waitForProfilingRequest({ timeout: 10000 });

  expect(profilingRequests).toHaveLength(1);
  expect(profilingRequests[0].contentType).toMatch(/multipart\/form-data/);
  expect(profilingRequests[0].headers['dd-api-key']).toBeDefined();
});

test.describe('quota_ko', () => {
  test.use({ initialIntakeQuotaDecision: 'quota_ko' });

  test('profiling bridge events are discarded when quota check returns quota_ko', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();

    const bridgeWindowPage = await mainPage.openBridgeHttpWindow(electronApp);

    await bridgeWindowPage.generateLongTask(500);
    await bridgeWindowPage.triggerProfilingFlush();

    await mainPage.flushTransport();

    await intake.assertNoProfilingRequest();
  });
});
