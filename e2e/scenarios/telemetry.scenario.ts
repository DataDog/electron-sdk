import { test, expect } from '../lib/helpers';
import {
  byRendererTelemetryType,
  byTelemetryType,
  isBridgeView,
  isMainProcessTelemetry,
  isRendererTelemetry,
  type ReceivedEvent,
} from '../lib/intake';
import type {
  TelemetryConfigurationEvent,
  TelemetryErrorEvent,
  TelemetryEvent,
  TelemetryUsageEvent,
} from '@datadog/electron-sdk';

/**
 * Every main-process telemetry event that counts toward the per-session cap, i.e. all but
 * `configuration`. Telemetry relayed from a renderer is excluded: the cap is the main process's budget,
 * and the browser SDK has already applied its own before its events cross the bridge.
 */
const isCapped = (event: ReceivedEvent<TelemetryEvent>) =>
  isMainProcessTelemetry(event) && !byTelemetryType('configuration')(event);

/**
 * The browser SDK version the bridge window runs, which relayed telemetry must keep reporting: the
 * event describes that SDK's behaviour, not the Electron SDK's.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const BROWSER_SDK_VERSION = (require('../app/node_modules/@datadog/browser-rum/package.json') as { version: string })
  .version;

/** A usage event relayed from a renderer, which the browser SDK emits once its view exists. */
const isRendererUsage = byRendererTelemetryType('usage');

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

  const event = usageEvents[0].body;
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
    // The cap (MAX_TELEMETRY_EVENTS_PER_SESSION) covers every telemetry type but `configuration`, so
    // the count is taken over all of them: the app provokes its errors through a public API, which
    // also reports one (deduplicated) usage event, and that one takes a slot too.
    await mainPage.generateTelemetryErrors(110);
    await mainPage.flushTransport();

    const cappedEvents = await intake.waitForEventCount('telemetry', 100, { predicate: isCapped });
    expect(cappedEvents).toHaveLength(100);

    await mainPage.renewSession();
    await mainPage.generateTelemetryError();
    await mainPage.flushTransport();

    // The renewed session starts a fresh budget, and deduplication resets with it, so both the error
    // and its usage event are sent again.
    const allCappedEvents = await intake.waitForEventCount('telemetry', 102, { predicate: isCapped });
    expect(allCappedEvents).toHaveLength(102);
  });
});

test.describe('renderer telemetry', () => {
  test('relays browser SDK telemetry, re-attributed to the Electron application and session', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    const own = await intake.getEventsByType('telemetry', { predicate: isMainProcessTelemetry });
    const ownTelemetry = own[0].body;

    await mainPage.openBridgeFileWindow(electronApp);

    const relayed = await mainPage.whileFlushing(() =>
      intake.waitForEventCount('telemetry', 1, { predicate: isRendererTelemetry })
    );
    const event = relayed[0].body;

    // The browser SDK stays the reported SDK: the event describes its behaviour, not the Electron SDK's,
    // so the service, source and version identifying it have to survive the relay.
    expect(event).toMatchObject({
      type: 'telemetry',
      source: 'browser',
      service: 'browser-rum-sdk',
      version: BROWSER_SDK_VERSION,
    });
    // Guards the assertion above against the two SDKs ever sharing a version number, which would let
    // a relay that restamped `version` still satisfy it.
    expect(BROWSER_SDK_VERSION).not.toBe(ownTelemetry.version);

    // The application and session are the main process's, replacing the ones the renderer reported — in
    // bridge mode the browser SDK's session id is a stub it generates for itself and nothing else knows.
    expect(event.application?.id).toBe('e2e-test-app-id');
    expect(event.session?.id).toMatch(/^[0-9a-f-]+$/);
    expect(event.session?.id).toBe(ownTelemetry.session?.id);
  });

  test('keeps the view the renderer reported, the one its RUM events carry', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await bridgeWindow.generateTelemetryUsage();

    const { bridgeViews, usage } = await mainPage.whileFlushing(async () => ({
      bridgeViews: await intake.waitForEventCount('view', 1, { predicate: isBridgeView }),
      usage: await intake.waitForEventCount('telemetry', 1, { predicate: isRendererUsage }),
    }));

    expect(usage[0].body.view?.id).toBe(bridgeViews[0].body.view.id);
  });

  test.describe('without a tracked Electron session', () => {
    test.use({ sdkConfigOverrides: { sessionSampleRate: 0 } });

    test("omits the browser SDK's stub session", async ({ electronApp, mainPage, intake }) => {
      await mainPage.openBridgeFileWindow(electronApp);

      const relayed = await mainPage.whileFlushing(() =>
        intake.waitForEventCount('telemetry', 1, { predicate: isRendererTelemetry })
      );

      expect(relayed[0].body.session).toBeUndefined();
    });
  });
});
