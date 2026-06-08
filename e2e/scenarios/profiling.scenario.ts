import { test, expect } from '../lib/helpers';
import type { ReceivedEvent } from '../lib/intake';
import type { RumViewEvent } from '@datadog/electron-sdk';

test.use({ rumBrowserSdk: {} });

// Bridge windows profile; the file:// main-process view cannot (no Document-Policy header).
function isBridgeView(event: ReceivedEvent): boolean {
  return (event.body as RumViewEvent).view.url !== 'electron://main-process';
}

function profilingContext(event: ReceivedEvent): RumViewEvent['_dd']['profiling'] {
  return (event.body as RumViewEvent)._dd.profiling;
}

test('browser SDK profiler flushes through bridge and reaches profiling intake', async ({
  electronApp,
  mainPage,
  intake,
}) => {
  await mainPage.flushTransport();

  const bridgeWindowPage = await mainPage.openBridgeAppProtocolWindow(electronApp);

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

  // The renderer profiler is running and owns the context, so electron leaves it untouched.
  // Assert on a view carrying the running status (not the first one, which may still be `starting`).
  const [runningView] = await intake.waitForEventCount('view', 1, {
    predicate: (event) => isBridgeView(event) && profilingContext(event)?.status === 'running',
  });
  expect(profilingContext(runningView)).toMatchObject({ status: 'running' });
});

test.describe('quota_ko', () => {
  test.use({ initialIntakeQuotaDecision: 'quota_ko' });

  test('profiling bridge events are discarded and RUM events report the quota reason', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();

    const bridgeWindowPage = await mainPage.openBridgeAppProtocolWindow(electronApp);

    await bridgeWindowPage.generateLongTask(500);
    await bridgeWindowPage.triggerProfilingFlush();

    await mainPage.flushTransport();

    await intake.assertNoProfilingRequest();

    // Electron owns quota gating: it forces `stopped` and stamps the reason on renderer RUM events
    // (mirroring the browser SDK), even though the renderer keeps profiling in bridge mode.
    const [stoppedView] = await intake.waitForEventCount('view', 1, {
      predicate: (event) => isBridgeView(event) && profilingContext(event)?.status === 'stopped',
    });
    expect(profilingContext(stoppedView)).toMatchObject({ status: 'stopped', quota_reason: 'quota_exceeded' });
  });
});

test.describe('sampled out', () => {
  test.use({ sdkConfigOverrides: { profilingSampleRate: 0 } });

  test('no profile is sent and renderer RUM events carry a null profiling context', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();

    const bridgeWindowPage = await mainPage.openBridgeAppProtocolWindow(electronApp);

    await bridgeWindowPage.generateLongTask(500);
    await bridgeWindowPage.triggerProfilingFlush();

    await mainPage.flushTransport();

    await intake.assertNoProfilingRequest();

    // Electron sampled the session out, so it overrides the context with an explicit `null`
    // (equivalent to absent for the backend: the session links no profile, so has_profile stays false).
    const [bridgeView] = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    expect((bridgeView.body as RumViewEvent)._dd).toHaveProperty('profiling', null);
  });
});
