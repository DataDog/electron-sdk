import { test, expect } from '../lib/helpers';
import { byTelemetryType } from '../lib/intake';
import type { TelemetryConfigurationEvent, TelemetryErrorEvent, TelemetryUsageEvent } from '@datadog/electron-sdk';

test('SDK sends telemetry error event to intake', async ({ mainPage, intake }) => {
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const telemetryEvents = await intake.getEventsByType('telemetry', { predicate: byTelemetryType('log') });
  expect(telemetryEvents).toHaveLength(1);

  const event = telemetryEvents[0].body as TelemetryErrorEvent;
  expect(event).toMatchObject({
    type: 'telemetry',
    service: 'electron-sdk',
    source: 'electron',
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
  });

  expect(event.telemetry.status).toBe('error');
  expect(event.telemetry.message).toBe('expected error 0');
  expect(event.telemetry.error?.kind).toBe('Error');
  expect(event.session?.id).toBeDefined();
  expect(event.application?.id).toBe('e2e-test-app-id');
  expect(event._dd.format_version).toBe(2);
});

test('SDK sends a configuration telemetry event on init', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();

  const configurationEvents = await intake.getSettledEventsByType('telemetry', {
    predicate: byTelemetryType('configuration'),
  });
  expect(configurationEvents).toHaveLength(1);

  const event = configurationEvents[0].body as TelemetryConfigurationEvent;
  expect(event).toMatchObject({
    type: 'telemetry',
    service: 'electron-sdk',
    source: 'electron',
  });
  expect(event.session?.id).toBeDefined();
  expect(event.application?.id).toBe('e2e-test-app-id');

  // The proxy points the SDK at the fake intake, so use_proxy is necessarily true here.
  expect(event.telemetry.configuration).toMatchObject({
    session_sample_rate: 100,
    telemetry_sample_rate: 100,
    use_proxy: true,
    is_main_process: true,
    track_errors: true,
  });
  // batch_size is the batch window in milliseconds, which for this SDK is the upload period itself.
  const { batch_size: batchSize, batch_upload_frequency: uploadFrequency } = event.telemetry.configuration;
  expect(uploadFrequency).toBeGreaterThan(0);
  expect(batchSize).toBe(uploadFrequency);

  // The app inits inside app.whenReady(), so the display count is readable; the number itself is the
  // host machine's and is not asserted.
  expect(event.telemetry.configuration.number_of_displays).toBeGreaterThan(0);

  // Whether dd-trace resolves is an environment fact, so only the pairing is asserted: a reported
  // tracer api must carry the version that goes with it.
  const { tracer_api: tracerApi, tracer_api_version: tracerApiVersion } = event.telemetry.configuration;
  if (tracerApi !== undefined) {
    expect(tracerApiVersion).toMatch(/^\d+\.\d+\.\d+/);
  }
});

test('SDK sends a usage telemetry event per public API used', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1' });
  await mainPage.addUserExtraInfo({ plan: 'premium' });
  await mainPage.addDurationVital('database.migration', { startTime: Date.now(), duration: 10 });
  await mainPage.startOperation('checkout');
  await mainPage.succeedOperation('checkout');
  await mainPage.flushTransport();

  // Settled: one usage event per API is expected, and a first-match read could return a partial list.
  const usageEvents = await intake.getSettledEventsByType('telemetry', { predicate: byTelemetryType('usage') });
  const usages = usageEvents.map((event) => (event.body as TelemetryUsageEvent).telemetry.usage);

  expect(usages).toEqual([
    { feature: 'set-user' },
    { feature: 'set-user-property' },
    { feature: 'add-duration-vital' },
    { feature: 'add-operation-step-vital', action_type: 'start' },
    { feature: 'add-operation-step-vital', action_type: 'succeed' },
  ]);

  const event = usageEvents[0].body as TelemetryUsageEvent;
  expect(event).toMatchObject({ type: 'telemetry', service: 'electron-sdk', source: 'electron' });
  expect(event.session?.id).toBeDefined();
  expect(event.application?.id).toBe('e2e-test-app-id');
});

test('SDK sends a usage telemetry event only once per distinct API use', async ({ mainPage, intake }) => {
  await mainPage.startOperation('checkout');
  await mainPage.startOperation('checkout');
  await mainPage.startOperation('other');
  await mainPage.flushTransport();

  // Settled rather than first-match: a duplicate could arrive in a later batch, and
  // `getEventsByType` would return before seeing it.
  const usageEvents = await intake.getSettledEventsByType('telemetry', { predicate: byTelemetryType('usage') });
  // The usage event carries no operation name, so all three calls produce the same event.
  expect(usageEvents).toHaveLength(1);
});

test('SDK deduplicates identical telemetry events within a session', async ({ mainPage, intake }) => {
  await mainPage.generateTelemetryError();
  await mainPage.generateTelemetryError();
  await mainPage.generateTelemetryError();
  await mainPage.flushTransport();

  const telemetryEvents = await intake.getSettledEventsByType('telemetry', { predicate: byTelemetryType('log') });
  expect(telemetryEvents).toHaveLength(1);
});

test.describe('telemetry rate-limit reset on session renewal', () => {
  test.use({ rumBrowserSdk: {} });

  test('telemetry events are limited per session and reset on session renewal', async ({ mainPage, intake }) => {
    // only 100 should be sent (MAX_TELEMETRY_EVENTS_PER_SESSION)
    await mainPage.generateTelemetryErrors(110);
    await mainPage.flushTransport();

    const telemetryEvents = await intake.waitForEventCount('telemetry', 100, { predicate: byTelemetryType('log') });
    expect(telemetryEvents).toHaveLength(100);

    await mainPage.renewSession();
    await mainPage.generateTelemetryError();
    await mainPage.flushTransport();

    const allTelemetryEvents = await intake.waitForEventCount('telemetry', 101, { predicate: byTelemetryType('log') });
    expect(allTelemetryEvents).toHaveLength(101);
  });
});
