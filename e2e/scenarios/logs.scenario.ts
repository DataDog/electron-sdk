import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isBridgeView, isMainProcessTelemetry } from '../lib/intake';

test.describe('main-process logs', () => {
  test('keeps main and renderer identity separate while attaching the main error stack and context', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.setUserInfo({ id: 'main-user' });
    await mainPage.setAccountInfo({ id: 'main-account' });
    const bridge = await mainPage.openBridgeFileWindow(electronApp);
    await mainPage.generateMainLog('main failure', 'error', { workspace: 'one' }, 'cannot open workspace');
    await bridge.generateLog('renderer message');
    await mainPage.flushTransport();
    const logs = await intake.waitForLogCount(2);
    const main = logs.find((log) => log.body.message === 'main failure')!;
    const renderer = logs.find((log) => log.body.message === 'renderer message')!;
    expect(main.ddforward).toContain('ddsource=electron');
    expect(renderer.ddforward).toContain('ddsource=browser');
    expect(main.body).toMatchObject({
      service: 'e2e-test-app',
      application_id: 'e2e-test-app-id',
      status: 'error',
      workspace: 'one',
      usr: { id: 'main-user' },
      account: { id: 'main-account' },
      error: {
        kind: 'Error',
        message: 'cannot open workspace',
        source_type: 'nodejs',
        stack: expect.stringContaining('main.js:'),
      },
    });
    expect(main.body.session_id).toBeTruthy();
    expect(main.body.session_id).toBe(renderer.body.session_id);
    expect(main.body.view?.id).toBeTruthy();
    expect(main.body.view?.id).not.toBe(renderer.body.view?.id);
    expect(renderer.body.service).toBe('e2e-renderer');
    expect(main.headers['dd-evp-origin']).toBe('electron');
  });

  test.describe('without a tracked RUM session', () => {
    test.use({ sdkConfigOverrides: { sessionSampleRate: 0 } });
    test('still sends ordinary main-process logs with application attribution', async ({ mainPage, intake }) => {
      await mainPage.generateMainLog('outside RUM');
      await mainPage.flushTransport();
      const [log] = await intake.waitForLogCount(1);
      expect(log.body).toMatchObject({
        application_id: 'e2e-test-app-id',
        session_id: null,
        session: { id: null },
        status: 'info',
      });
      expect(log.body.error).toBeUndefined();
    });
  });

  test.describe('sampling', () => {
    test.use({ sdkConfigOverrides: { logsSampleRate: 0 } });
    test('drops main logs when logsSampleRate is zero', async ({ mainPage, intake }) => {
      await mainPage.generateMainLog('sampled out');
      await mainPage.flushTransport();
      expect(intake.getLogs()).toEqual([]);
    });
  });

  test('delivers valid main and renderer logs when the intake rejects mixed batches as too large', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    intake.setLogsResponseStatus((logs) =>
      logs.length > 1 || logs.some((log) => log.message === 'rejected log') ? 413 : 202
    );
    const bridge = await mainPage.openBridgeFileWindow(electronApp);
    for (const message of ['before rejection', 'rejected log', 'after rejection']) {
      await mainPage.generateMainLog(message);
      await bridge.generateLog(message);
    }
    await mainPage.flushTransport();
    const logs = await intake.waitForLogCount(4);
    for (const source of ['electron', 'browser']) {
      expect(logs.filter((log) => log.ddforward.includes(`ddsource=${source}`)).map((log) => log.body.message)).toEqual(
        ['before rejection', 'after rejection']
      );
    }
    await mainPage.flushTransport();
    expect(intake.getLogs()).toHaveLength(4);
  });

  test('recovers failed main and renderer uploads with their original source even after sampling is disabled', async ({
    intake,
  }) => {
    const userData = await createUserDataDir();
    let activeApp: Awaited<ReturnType<typeof launchAppManually>>['electronApp'] | undefined;
    try {
      intake.setLogsResponseStatus(503);
      const first = await launchAppManually(intake, userData);
      activeApp = first.electronApp;
      const bridge = await first.mainPage.openBridgeFileWindow(activeApp);
      await first.mainPage.generateMainLog('recover main');
      await bridge.generateLog('recover renderer');
      await first.mainPage.flushTransport();

      for (const [directory, message] of [
        ['dd_main_logs', 'recover main'],
        ['dd_logs', 'recover renderer'],
      ]) {
        const files = (await readdir(join(userData, directory))).filter((file) => file.endsWith('.log'));
        expect(files.length).toBeGreaterThan(0);
        const contents = await Promise.all(files.map((file) => readFile(join(userData, directory, file), 'utf8')));
        expect(contents.join('')).toContain(message);
      }
      expect(intake.getLogs()).toEqual([]);
      await activeApp.close();
      activeApp = undefined;
      intake.setLogsResponseStatus(202);
      const restarted = await launchAppManually(intake, userData, { logsSampleRate: 0 });
      activeApp = restarted.electronApp;
      await restarted.mainPage.flushTransport();
      const logs = await intake.waitForLogCount(2);
      expect(logs.find((log) => log.body.message === 'recover main')?.ddforward).toContain('ddsource=electron');
      expect(logs.find((log) => log.body.message === 'recover renderer')?.ddforward).toContain('ddsource=browser');
      for (const directory of ['dd_main_logs', 'dd_logs']) {
        expect((await readdir(join(userData, directory))).filter((file) => file.endsWith('.log'))).toEqual([]);
      }
    } finally {
      await activeApp?.close();
      await cleanupUserDataDir(userData);
    }
  });
});

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
