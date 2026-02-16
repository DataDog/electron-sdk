import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';

test('SDK initialization with default config', async ({ window }) => {
  const statusDiv = window.locator('#status');
  await expect(statusDiv).toContainText('SDK initialized');
});

test('SDK sends RUM view event to intake', async ({ intake }) => {
  const events = await intake.getEventsByType('view');
  expect(events).toHaveLength(1);

  const event = events[0];
  const rumEvent = event.body as RumViewEvent;

  expect(rumEvent).toMatchObject({
    type: 'view',
    service: 'e2e-test-app',
  });

  expect(rumEvent.date).toBeDefined();
  expect(rumEvent.session.id).toBeDefined();
  expect(rumEvent.view.id).toBeDefined();
  expect(rumEvent.view.name).toBeDefined();
  expect(rumEvent.view.url).toBeDefined();
  expect(rumEvent.application.id).toBeDefined();
  expect(rumEvent._dd.format_version).toBe(2);

  expect(event.headers['content-type']).toContain('application/json');
  expect(event.headers['dd-api-key']).toBe('test-client-token');
});
