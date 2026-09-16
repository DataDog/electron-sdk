import { test, expect } from '../lib/helpers';

test.describe('tracking consent', () => {
  test.use({ sdkConfigOverrides: { trackingConsent: 'pending' } });

  test('keeps pending events local until consent is granted', async ({ mainPage, intake }) => {
    await mainPage.generateManualError(undefined, { consent_marker: 'pending-then-granted' });
    await mainPage.flushTransport();

    await intake.assertNoNewEvents('error');

    await mainPage.setTrackingConsent('granted');
    const errors = await mainPage.whileFlushing(() =>
      intake.waitForEventCount('error', 1, {
        predicate: (event) => event.body.context?.consent_marker === 'pending-then-granted',
      })
    );

    expect(errors).toHaveLength(1);
  });

  test('deletes pending events when consent is rejected', async ({ mainPage, intake }) => {
    await mainPage.generateManualError(undefined, { consent_marker: 'rejected' });
    await mainPage.flushTransport();

    await mainPage.setTrackingConsent('not-granted');
    await mainPage.setTrackingConsent('granted');
    await mainPage.flushTransport();

    await intake.assertNoNewEvents('error');
  });
});
