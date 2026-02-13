import { test, expect } from '../lib/helpers';
import type { TelemetryErrorEvent } from '@datadog/electron-sdk';

test('SDK sends telemetry error event to intake', async ({ window, intake }) => {
  const button = window.locator('#generate-telemetry-error');
  await button.click();

  const telemetryEvents = await intake.getEventsByType('telemetry');
  expect(telemetryEvents).toHaveLength(1);

  const event = telemetryEvents[0].body as TelemetryErrorEvent;
  expect(event).toMatchObject({
    type: 'telemetry',
    service: 'electron-sdk',
    source: 'electron',
  });

  expect(event.telemetry.status).toBe('error');
  expect(event.telemetry.message).toBe('expected error');
  expect(event.telemetry.error?.kind).toBe('Error');
  expect(event.session?.id).toBeDefined();
  expect(event.application?.id).toBe('e2e-test-app-id');
  expect(event._dd.format_version).toBe(2);
});
