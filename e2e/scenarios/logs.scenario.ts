import { test, expect } from '../lib/helpers';
import { isBridgeView, isMainProcessTelemetry } from '../lib/intake';

/**
 * Logs from a renderer only reach Datadog through the bridge. Once the preload is injected and the
 * renderer's host is allowed, the browser Logs SDK picks its bridge transport over its batch
 * transport and its `clientToken` is rewritten to `'empty'`, so it cannot reach intake on its own —
 * anything the main process fails to relay is lost outright.
 */
test.describe('renderer logs', () => {
  test.use({ sdkConfigOverrides: { batchSize: 'LARGE' } });

  test('relays a renderer log on the logs track, re-attributed to the Electron application and session', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.flushTransport();
    const own = await intake.getEventsByType('telemetry', { predicate: isMainProcessTelemetry });
    const mainProcessSessionId = own[0].body.session?.id;
    expect(mainProcessSessionId).toBeDefined();

    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await bridgeWindow.generateLog('workspace switched', { workspace: 'e2e' });

    const logs = await mainPage.whileFlushing(() =>
      intake.waitForLogCount(1, { predicate: (log) => log.body.message === 'workspace switched' })
    );
    const log = logs[0];

    // The log keeps the Browser Logs SDK's source even though Electron relays it. The origin header
    // separately identifies the SDK that performed the upload.
    expect(log.ddforward).toContain('/api/v2/logs');
    expect(log.ddforward).toContain('ddsource=browser');
    expect(log.headers['dd-evp-origin']).toBe('electron');

    // The application and session are the main process's, replacing what the renderer reported: in
    // bridge mode the browser SDK's session id is a stub it generates for itself.
    expect(log.body.application_id).toBe('e2e-test-app-id');
    expect(log.body.session_id).toBe(mainProcessSessionId);
    expect(log.body.session?.id).toBe(mainProcessSessionId);

    // Everything describing the log itself stays the renderer's — it configured them in its own
    // `DD_LOGS.init()`, and relabelling them would rewrite the customer's own logs.
    expect(log.body).toMatchObject({
      message: 'workspace switched',
      status: 'info',
      service: 'e2e-renderer',
      origin: 'logger',
    });
    expect(log.body.ddtags).toContain('env:e2e');
    expect(log.body.workspace).toBe('e2e');
  });

  test('keeps the view the renderer reported, the one its RUM events carry', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await bridgeWindow.generateLog('log with a view');

    const { bridgeViews, logs } = await mainPage.whileFlushing(async () => ({
      bridgeViews: await intake.waitForEventCount('view', 1, { predicate: isBridgeView }),
      logs: await intake.waitForLogCount(1, { predicate: (log) => log.body.message === 'log with a view' }),
    }));

    expect(logs[0].body.view?.id).toBe(bridgeViews[0].body.view.id);
  });

  test('attaches the main process user to a renderer log', async ({ electronApp, mainPage, intake }) => {
    await mainPage.setUserInfo({ id: 'main-user', name: 'Main User' });

    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    await bridgeWindow.generateLog('log with a user');

    const logs = await mainPage.whileFlushing(() =>
      intake.waitForLogCount(1, { predicate: (log) => log.body.message === 'log with a user' })
    );

    expect(logs[0].body.usr).toMatchObject({ id: 'main-user', name: 'Main User' });
  });

  test.describe('sampling', () => {
    test.use({ sdkConfigOverrides: { logsSampleRate: 0 } });

    test('drops renderer logs when logsSampleRate is 0', async ({ electronApp, mainPage, intake }) => {
      const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);

      await bridgeWindow.generateLog('sampled out renderer log');
      await mainPage.flushTransport();

      expect(intake.getLogs().filter((log) => log.body.message === 'sampled out renderer log')).toHaveLength(0);
    });
  });

  test('relays every log sampled in at logsSampleRate 100 without applying a relay cap', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);

    // Above both the 100-event per-session cap that bounds relayed telemetry and the 1,000-entry Logs
    // intake request limit. Collection stays uncapped, while transport must split the upload.
    // Messages are distinct because identical payloads are indistinguishable in the intake store.
    const total = 1_001;
    await bridgeWindow.generateLogs(total, 'bulk log ');

    const logs = await mainPage.whileFlushing(() =>
      intake.waitForLogCount(total, { predicate: (log) => String(log.body.message).startsWith('bulk log ') })
    );

    expect(new Set(logs.map((log) => log.body.message)).size).toBe(total);
    expect(intake.getLogRequestSizes()).toEqual([1_000, 1]);
  });
});
