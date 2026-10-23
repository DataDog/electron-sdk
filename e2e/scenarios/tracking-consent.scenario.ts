import { test, expect } from '../lib/helpers';
import { isBridgeView, isMainProcessView } from '../lib/intake';

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

test('preserves the final authorized main view when the following pending interval is rejected', async ({
  mainPage,
  intake,
}) => {
  const [initial] = await mainPage.whileFlushing(() =>
    intake.waitForEventCount('view', 1, { predicate: isMainProcessView })
  );
  await mainPage.generateManualError();
  await mainPage.setTrackingConsent('pending');
  await mainPage.generateManualError();
  await mainPage.setTrackingConsent('not-granted');

  const [closed] = await mainPage.whileFlushing(() =>
    intake.waitForEventCount('view', 1, {
      predicate: (event) => event.body.view.id === initial.body.view.id && event.body.view.is_active === false,
    })
  );
  expect(closed.body.view.error.count).toBe(1);
});

test.describe('tracking consent — HTTP propagation', () => {
  test.use({ sdkConfigOverrides: { trackingConsent: 'pending', traceSampleRate: 100 } });

  for (const api of ['mainFetch', 'mainHttpRequest', 'mainNetFetch', 'mainNetRequest'] as const) {
    test(`${api} propagates only while consent is granted`, async ({ mainPage, intake, testServer }) => {
      const pendingUrl = testServer.urlFor(200);
      await mainPage[api](pendingUrl);
      expect(testServer.headersFor(200)['x-datadog-trace-id']).toBeUndefined();
      expect(testServer.headersFor(200).traceparent).toBeUndefined();

      await mainPage.setTrackingConsent('granted');
      await mainPage.whileFlushing(() =>
        intake.waitForEventCount('resource', 1, { predicate: (event) => event.body.resource.url === pendingUrl })
      );
      await mainPage[api](testServer.urlFor(201));
      expect(testServer.headersFor(201)['x-datadog-trace-id']).toBeDefined();

      await mainPage.setTrackingConsent('not-granted');
      await mainPage[api](testServer.urlFor(202));
      expect(testServer.headersFor(202)['x-datadog-trace-id']).toBeUndefined();
      expect(testServer.headersFor(202).traceparent).toBeUndefined();

      await mainPage.setTrackingConsent('granted');
      await mainPage[api](testServer.urlFor(203));
      expect(testServer.headersFor(203)['x-datadog-trace-id']).toBeDefined();
    });
  }
});

for (const initialConsent of ['granted', 'not-granted'] as const) {
  test.describe(`tracking consent — Browser bridge (${initialConsent})`, () => {
    test.use({
      sdkConfigOverrides: { trackingConsent: initialConsent, profilingSampleRate: 0, sessionReplaySampleRate: 0 },
    });

    test('preserves Browser view identity, customer context and log correlation', async ({
      electronApp,
      mainPage,
      intake,
    }) => {
      const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
      const browserViewId = await bridgeWindow.page.evaluate(() => {
        const rum = (
          globalThis as unknown as {
            DD_RUM: {
              getInternalContext(): { view: { id: string } };
              setUser(user: { id: string }): void;
              setAccount(account: { id: string }): void;
              setGlobalContextProperty(key: string, value: string): void;
            };
          }
        ).DD_RUM;
        rum.setUser({ id: 'renderer-user' });
        rum.setAccount({ id: 'renderer-account' });
        rum.setGlobalContextProperty('workspace', 'renderer-workspace');
        return rum.getInternalContext().view.id;
      });
      if (initialConsent === 'not-granted') {
        await mainPage.flushTransport();
        await intake.assertNoNewEvents('view');
      }
      await mainPage.setTrackingConsent('granted');
      const errorMessage = 'renderer error after consent grant';
      const logMessage = 'renderer log after consent grant';
      await bridgeWindow.generateError(errorMessage);
      await bridgeWindow.generateLog(logMessage);
      const views = await mainPage.whileFlushing(() =>
        intake.waitForEventCount('view', 1, {
          predicate: (event) =>
            isBridgeView(event) && event.body.view.id === browserViewId && event.body.view.error.count > 0,
        })
      );
      const errors = await intake.waitForEventCount('error', 1, {
        predicate: (event) => event.body.error.message === errorMessage,
      });
      const logs = await intake.waitForLogCount(1, { predicate: (log) => log.body.message === logMessage });

      expect(errors[0].body.view.id).toBe(browserViewId);
      expect(logs[0].body.view?.id).toBe(browserViewId);
      expect(views[0].body).toMatchObject({
        usr: { id: 'renderer-user' },
        account: { id: 'renderer-account' },
        context: { workspace: 'renderer-workspace' },
      });
    });

    test.describe('beforeSend', () => {
      test.use({ beforeSendRumEnabled: true });
      test('preserves the Browser view counter when Electron drops an error', async ({
        electronApp,
        mainPage,
        intake,
      }) => {
        const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
        await electronApp.evaluate(() => {
          (
            globalThis as unknown as { __ddE2E: { beforeSendRum: (event: { type: string }) => boolean } }
          ).__ddE2E.beforeSendRum = (event) => event.type !== 'error';
        });
        await mainPage.setTrackingConsent('granted');
        await bridgeWindow.generateError('filtered renderer error');
        const views = await mainPage.whileFlushing(() =>
          intake.waitForEventCount('view', 1, {
            predicate: (event) => isBridgeView(event) && event.body.view.error.count === 1,
          })
        );
        expect(views[0].body.view.error.count).toBe(1);
        await intake.assertNoNewEvents('error');
      });
    });
  });
}

test.describe('tracking consent — replay resume', () => {
  test.use({
    sdkConfigOverrides: { trackingConsent: 'not-granted', profilingSampleRate: 0, sessionReplaySampleRate: 100 },
  });

  test('waits for a fresh Browser full snapshot after consent is granted', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.setTrackingConsent('granted');
    await bridgeWindow.page.evaluate(() => {
      const { document } = globalThis as unknown as {
        document: { body: { setAttribute(name: string, value: string): void } };
      };
      document.body.setAttribute('data-after-consent', 'true');
    });
    await bridgeWindow.page.waitForTimeout(6000);
    await mainPage.flushTransport();
    expect(intake.getReplaySegments()).toEqual([]);

    const newViewId = await bridgeWindow.page.evaluate(() => {
      const rum = (
        globalThis as unknown as {
          DD_RUM: {
            startView(name: string): void;
            getInternalContext(): { view: { id: string } };
          };
        }
      ).DD_RUM;
      rum.startView('after-consent');
      return rum.getInternalContext().view.id;
    });
    await mainPage.whileFlushing(async () => {
      await expect.poll(() => intake.getReplaySegments().length, { timeout: 12000 }).toBeGreaterThan(0);
    });
    const segment = intake.getReplaySegments()[0];
    expect(segment.metadata).toMatchObject({ view: { id: newViewId }, has_full_snapshot: true });
    expect(segment.records?.some((record) => (record as { type: number }).type === 2)).toBe(true);
    const views = await intake.waitForEventCount('view', 1, { predicate: (event) => event.body.view.id === newViewId });
    expect(views[0].body.session.id).toBe((segment.metadata.session as { id: string }).id);
  });
});

test.describe('tracking consent — deferred main resource', () => {
  test.use({
    sdkConfigOverrides: { trackingConsent: 'granted', profilingSampleRate: 0, sessionReplaySampleRate: 0 },
  });

  test('keeps a resource captured before consent is revoked', async ({ mainPage, intake }) => {
    await mainPage.generateManualError();
    await mainPage.flushTransport();
    intake.clear();

    await mainPage.setTrackingConsent('not-granted');
    const url = 'https://example.com/deferred-authorized-resource';
    await mainPage.exportTestSpan(url, 50);
    await mainPage.flushTransport();

    await intake.waitForSpan((span) => span.meta['http.url'] === url);
    const resources = await intake.waitForEventCount('resource', 1, {
      predicate: (event) => event.body.resource.url === url,
    });
    expect(resources).toHaveLength(1);
  });
});

test.describe('tracking consent — main beforeSend', () => {
  test.use({
    beforeSendRumEnabled: true,
    sdkConfigOverrides: { trackingConsent: 'pending', profilingSampleRate: 0, sessionReplaySampleRate: 0 },
  });

  test('does not reauthorize a pending error rejected by beforeSendRum', async ({ electronApp, mainPage, intake }) => {
    await electronApp.evaluate(() => {
      const controls = (
        globalThis as unknown as {
          __ddE2E: {
            beforeSendRum: (event: { type: string; error?: { message?: string } }) => boolean;
            setTrackingConsent: (consent: 'granted' | 'not-granted' | 'pending') => void;
          };
        }
      ).__ddE2E;
      controls.beforeSendRum = (event) => {
        if (event.type === 'error' && event.error?.message === 'test manual error') {
          controls.setTrackingConsent('not-granted');
          controls.setTrackingConsent('granted');
        }
        return true;
      };
    });

    await mainPage.generateManualError();
    await mainPage.flushTransport();

    await intake.assertNoNewEvents('error');
  });
});
