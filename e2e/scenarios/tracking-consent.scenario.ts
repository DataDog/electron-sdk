import { test, expect } from '../lib/helpers';

test.describe('tracking consent', () => {
  test.describe('starting pending', () => {
    test.use({ sdkConfigOverrides: { trackingConsent: 'pending' } });

    test('uploads the data kept while pending once consent is granted', async ({ mainPage, intake }) => {
      await mainPage.generateManualError();
      await mainPage.flushTransport();
      await intake.assertNoNewEvents('error');

      await mainPage.setTrackingConsent('granted');
      await mainPage.flushTransport();

      expect(await intake.getSettledEventsByType('error')).toHaveLength(1);
    });

    test('deletes the data kept while pending when consent is refused', async ({ mainPage, intake }) => {
      await mainPage.generateManualError(undefined, { kept: 'while pending' });
      await mainPage.flushTransport();

      await mainPage.setTrackingConsent('not-granted');
      await mainPage.setTrackingConsent('granted');
      await mainPage.generateManualError(undefined, { kept: 'once granted' });
      await mainPage.flushTransport();

      const errors = await intake.getSettledEventsByType('error');
      expect(errors.map(({ body }) => body.context?.kept)).toEqual(['once granted']);
    });

    test('sends no profiling quota check until consent is granted', async ({ mainPage, intake }) => {
      await mainPage.flushTransport();
      expect(intake.getQuotaCheckCount()).toBe(0);

      await mainPage.setTrackingConsent('granted');

      await expect.poll(() => intake.getQuotaCheckCount()).toBe(1);
    });
  });

  test.describe('starting refused', () => {
    test.use({ sdkConfigOverrides: { trackingConsent: 'not-granted', traceSampleRate: 100 } });

    test('sends nothing and propagates no trace context until consent is granted', async ({
      mainPage,
      intake,
      testServer,
    }) => {
      await mainPage.mainNetRequest(testServer.urlFor(204));
      await mainPage.generateManualError();
      await mainPage.flushTransport();

      expect(testServer.headersFor(204)['x-datadog-trace-id']).toBeUndefined();
      await intake.assertNoNewEvents('error');
      await intake.assertNoNewEvents('telemetry');
      await intake.assertNoNewEvents('resource');
      await intake.assertNoNewEvents('view');
      expect(intake.getSpans()).toEqual([]);

      await mainPage.setTrackingConsent('granted');
      await mainPage.mainNetRequest(testServer.urlFor(205));
      await mainPage.generateManualError();
      await mainPage.flushTransport();

      expect(testServer.headersFor(205)['x-datadog-trace-id']).toBeDefined();
      expect(await intake.getSettledEventsByType('error')).toHaveLength(1);
    });
  });

  test('starts a new session when consent is granted again after a refusal', async ({ mainPage, intake }) => {
    await mainPage.generateManualError();
    await mainPage.flushTransport();

    await mainPage.setTrackingConsent('not-granted');
    await mainPage.setTrackingConsent('granted');
    await mainPage.generateManualError();
    await mainPage.flushTransport();

    const [beforeRefusal, afterGrant] = await intake.waitForEventCount('error', 2);
    expect(afterGrant.body.session.id).not.toBe(beforeRefusal.body.session.id);
  });
});
