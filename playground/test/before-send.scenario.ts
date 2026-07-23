import type { RumErrorEvent } from '@datadog/electron-sdk';
import { expect, flushTransport, test } from './helpers';

test('playground demonstrates beforeSend scrubbing and filtering', async ({ intake, window }) => {
  await window.click('#before-send-scrub');
  await window.click('#before-send-filter');
  await flushTransport(window);

  const errorEvents = await intake.getEventsByType('error');

  expect(errorEvents).toHaveLength(1);
  expect(errorEvents[0].body as RumErrorEvent).toMatchObject({
    error: { message: '[REDACTED by beforeSend]' },
    context: { email: '[REDACTED]' },
  });
});
