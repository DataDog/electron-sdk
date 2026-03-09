import { test, expect } from '../lib/helpers';
import type { TelemetryErrorEvent } from '@datadog/electron-sdk';

test('SDK sends telemetry error event to intake', async ({ app, intake }) => {
  await app.generateTelemetryError();

  const telemetryEvents = await intake.getEventsByType('telemetry');
  expect(telemetryEvents).toHaveLength(1);

  const event = telemetryEvents[0].body as TelemetryErrorEvent;
  expect(event).toMatchObject({
    type: 'telemetry',
    service: 'electron-sdk',
    source: 'electron',
    version: expect.stringMatching(/^\d+\.\d+\.\d+$/),
  });

  expect(event.telemetry.status).toBe('error');
  expect(event.telemetry.message).toBe('expected error');
  expect(event.telemetry.error?.kind).toBe('Error');
  expect(event.session?.id).toBeDefined();
  expect(event.application?.id).toBe('e2e-test-app-id');
  expect(event._dd.format_version).toBe(2);
});

test('telemetry events are limited per session and reset on session renewal', async ({ app, intake }) => {
  // only 100 should be sent (MAX_TELEMETRY_EVENTS_PER_SESSION)
  await app.generateTelemetryErrors(110);

  const telemetryEvents = await intake.waitForEventCount('telemetry', 100);
  expect(telemetryEvents).toHaveLength(100);

  await app.renewSession();
  await app.generateTelemetryError();

  const allTelemetryEvents = await intake.waitForEventCount('telemetry', 101);
  expect(allTelemetryEvents).toHaveLength(101);
});
