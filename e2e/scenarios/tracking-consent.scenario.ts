import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ElectronApplication } from '@playwright/test';
import type { TrackingConsent } from '@datadog/electron-sdk';
import { ONE_SECOND } from '@datadog/js-core/time';
import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { decodeSessionReplay, isBridgeView, isMainProcessEvent, replayRecordsJson } from '../lib/intake';

test.describe('tracking consent', () => {
  test.describe('starting pending', () => {
    test.use({ sdkConfigOverrides: { trackingConsent: 'pending', traceSampleRate: 100 } });

    test('uploads the data kept while pending once consent is granted', async ({ electronApp, mainPage, intake }) => {
      const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
      const profiledWindow = await mainPage.openBridgeAppProtocolWindow(electronApp);
      await mainPage.generateManualError();
      await bridgeWindow.generateError('renderer error');
      await bridgeWindow.generateLog('renderer log');
      await profiledWindow.generateLongTask(500);
      await profiledWindow.triggerProfilingFlush();
      await mainPage.flushTransport();
      await intake.assertNoNewEvents('error');
      await intake.assertNoNewEvents('view');
      expect(intake.getLogs()).toEqual([]);
      expect(intake.getProfilingRequests()).toEqual([]);

      await mainPage.setTrackingConsent('granted');

      const errors = await mainPage.whileFlushing(async () => {
        await intake.getEventsByType('view', { predicate: isBridgeView });
        await intake.waitForLogCount(1, { predicate: ({ body }) => body.message === 'renderer log' });
        await intake.waitForProfilingRequest();
        return intake.getSettledEventsByType('error');
      });
      expect(errors.map(({ body }) => body.error.message).sort()).toEqual(['renderer error', 'test manual error']);
    });

    test('deletes the data kept while pending when consent is refused', async ({ electronApp, mainPage, intake }) => {
      const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
      const profiledWindow = await mainPage.openBridgeAppProtocolWindow(electronApp);
      await mainPage.generateManualError(undefined, { kept: 'while pending' });
      await bridgeWindow.generateError('renderer error while pending');
      await bridgeWindow.generateLog('renderer log while pending');
      await profiledWindow.generateLongTask(500);
      await profiledWindow.triggerProfilingFlush();
      await mainPage.flushTransport();
      const refusedAt = Date.now();

      await mainPage.setTrackingConsent('not-granted');
      await mainPage.flushTransport();
      await mainPage.setTrackingConsent('granted');
      await mainPage.generateManualError(undefined, { kept: 'once granted' });
      await bridgeWindow.generateError('renderer error once granted');
      await bridgeWindow.generateLog('renderer log once granted');

      const errors = await mainPage.whileFlushing(async () => {
        await intake.waitForLogCount(1, { predicate: ({ body }) => body.message === 'renderer log once granted' });
        return intake.getSettledEventsByType('error');
      });
      expect(errors.map(({ body }) => body.context?.kept ?? body.error.message).sort()).toEqual([
        'once granted',
        'renderer error once granted',
      ]);
      expect(intake.getLogs().filter(({ body }) => body.message.includes('while pending'))).toEqual([]);
      expect(intake.getReplaySegments().filter(({ metadata }) => Number(metadata.start) < refusedAt)).toEqual([]);
      expect(intake.getProfilingRequests()).toEqual([]);
    });

    test('propagates trace context while consent is pending', async ({ mainPage, testServer }) => {
      await mainPage.mainNetRequest(testServer.urlFor(204));

      expect(testServer.headersFor(204)['x-datadog-trace-id']).toBeDefined();
    });

    test('sends no profiling quota check until consent is granted', async ({ mainPage, intake }) => {
      await mainPage.flushTransport();
      expect(intake.getQuotaCheckCount()).toBe(0);

      await mainPage.setTrackingConsent('granted');

      await expect.poll(() => intake.getQuotaCheckCount()).toBe(1);
    });

    test.describe('with replay text unmasked', () => {
      test.use({
        // Only the flushes upload, so the test controls which segments each upload sends.
        sdkConfigOverrides: { trackingConsent: 'pending', defaultPrivacyLevel: 'allow', uploadFrequency: 'RARE' },
      });

      test('sends a complete replay recorded while pending once consent is granted', async ({
        electronApp,
        mainPage,
        intake,
      }) => {
        const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
        for (const text of ['RecordedWhilePending1', 'RecordedWhilePending2']) {
          await bridgeWindow.appendText(text);
          // Ends the current segment, which is kept on disk while consent is pending.
          await mainPage.flushTransport();
        }
        expect(intake.getReplaySegments()).toEqual([]);

        await mainPage.setTrackingConsent('granted');
        // Uploaded with the segments kept while pending, which must go first for the replay to decode.
        await bridgeWindow.appendText('RecordedOnceGranted');

        await mainPage.whileFlushing(() =>
          expect
            .poll(() => replayRecordsJson(intake.getReplaySegments()), { timeout: 20 * ONE_SECOND })
            .toContain('RecordedOnceGranted')
        );
        const received = intake.getReplaySegments();
        const segments = decodeSessionReplay(received);
        expect(segments.map(({ index_in_view }) => index_in_view)).toEqual(segments.map((_, index) => index));
        expect(segments[0].has_full_snapshot).toBe(true);
        expect(segments.map(({ records }) => records.length)).toEqual(
          received.map(({ metadata }) => metadata.records_count)
        );
        const recorded = replayRecordsJson(received);
        expect(recorded).toContain('RecordedWhilePending1');
        expect(recorded).toContain('RecordedWhilePending2');
      });
    });
  });

  test.describe('starting refused', () => {
    test.use({ sdkConfigOverrides: { trackingConsent: 'not-granted', traceSampleRate: 100 } });

    test('sends nothing and propagates no trace context until consent is granted', async ({
      electronApp,
      mainPage,
      intake,
      testServer,
    }) => {
      const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
      await mainPage.mainNetRequest(testServer.urlFor(204));
      await mainPage.generateManualError();
      await bridgeWindow.generateLog('renderer log while refused');
      await mainPage.flushTransport();

      expect(testServer.headersFor(204)['x-datadog-trace-id']).toBeUndefined();
      await intake.assertNoNewEvents('error');
      await intake.assertNoNewEvents('telemetry');
      await intake.assertNoNewEvents('resource');
      await intake.assertNoNewEvents('view');
      expect(intake.getSpans()).toEqual([]);
      expect(intake.getLogs()).toEqual([]);
      expect(intake.getReplaySegments()).toEqual([]);

      await mainPage.setTrackingConsent('granted');
      const grantedUrl = testServer.urlFor(205);
      await mainPage.mainNetRequest(grantedUrl);
      await mainPage.generateManualError();
      await bridgeWindow.generateLog('renderer log once granted');

      expect(testServer.headersFor(205)['x-datadog-trace-id']).toBeDefined();
      await mainPage.whileFlushing(async () => {
        await intake.getEventsByType('execution_context', { predicate: isMainProcessEvent });
        await intake.getEventsByType('resource', { predicate: ({ body }) => body.resource.url === grantedUrl });
        await intake.waitForSpan((span) => span.name === 'http.request' && span.meta['http.url'] === grantedUrl);
        await intake.waitForLogCount(1);
      });
      expect(await intake.getSettledEventsByType('error')).toHaveLength(1);
      expect(intake.getLogs().map(({ body }) => body.message)).toEqual(['renderer log once granted']);
    });

    test('sends the replay and profiles of a renderer opened once consent is granted', async ({
      electronApp,
      mainPage,
      intake,
    }) => {
      await mainPage.setTrackingConsent('granted');
      const bridgeWindow = await mainPage.openBridgeAppProtocolWindow(electronApp);
      await bridgeWindow.generateLongTask(500);
      await bridgeWindow.triggerProfilingFlush();

      await mainPage.whileFlushing(async () => {
        await intake.waitForProfilingRequest();
        await intake.waitForReplaySegment();
      });
      expect(decodeSessionReplay(intake.getReplaySegments())[0].has_full_snapshot).toBe(true);
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

  test.describe('across launches', () => {
    let userDataDir: string;
    let activeApp: ElectronApplication | undefined;

    test.beforeEach(async () => {
      test.setTimeout(60 * ONE_SECOND);
      userDataDir = await createUserDataDir();
    });

    test.afterEach(async () => {
      try {
        await activeApp?.close();
      } finally {
        activeApp = undefined;
        await cleanupUserDataDir(userDataDir);
      }
    });

    test('deletes the data kept while pending at the next launch when no decision was made', async ({ intake }) => {
      const keptWhilePending = ['main error kept while pending', 'renderer log kept while pending'];
      const first = await launchAppManually(intake, userDataDir, { trackingConsent: 'pending' });
      activeApp = first.electronApp;
      const bridgeWindow = await first.mainPage.openBridgeFileWindow(first.electronApp);
      await first.mainPage.generateManualError(undefined, { kept: keptWhilePending[0] });
      await bridgeWindow.generateLog(keptWhilePending[1]);
      await first.electronApp.close();
      activeApp = undefined;
      expect(await textsOnDisk(userDataDir, keptWhilePending)).toEqual(keptWhilePending);

      const second = await launchAppManually(intake, userDataDir, { trackingConsent: 'pending' });
      activeApp = second.electronApp;
      await second.mainPage.setTrackingConsent('granted');
      await second.mainPage.generateManualError(undefined, { kept: 'current launch' });

      const { errors, views } = await second.mainPage.whileFlushing(async () => ({
        errors: await intake.getSettledEventsByType('error'),
        views: await intake.getSettledEventsByType('view'),
      }));
      await second.electronApp.close();
      activeApp = undefined;
      expect(errors.map(({ body }) => body.context?.kept)).toEqual(['current launch']);
      expect(views.filter(isBridgeView)).toEqual([]);
      expect(intake.getLogs()).toEqual([]);
      expect(intake.getReplaySegments()).toEqual([]);
      expect(await textsOnDisk(userDataDir, keptWhilePending)).toEqual([]);
    });

    for (const { consent, sent } of [
      { consent: 'granted', sent: true },
      { consent: 'not-granted', sent: false },
      { consent: 'pending', sent: false },
    ] satisfies { consent: TrackingConsent; sent: boolean }[]) {
      test(`${sent ? 'sends' : 'drops'} a crash that happened while consent was ${consent}`, async ({ intake }) => {
        const first = await launchAppManually(intake, userDataDir, { trackingConsent: 'pending' });
        activeApp = first.electronApp;
        const crashDumpsPath = await first.electronApp.evaluate(({ app }) => app.getPath('crashDumps'));
        await first.mainPage.setTrackingConsent(consent);
        // The consent history is written to disk asynchronously: let it land before the crash.
        await first.window.waitForTimeout(ONE_SECOND);
        const appClosed = first.electronApp.waitForEvent('close');
        first.mainPage.crash();
        await appClosed;
        activeApp = undefined;
        expect(await filesWithExtension(crashDumpsPath, '.dmp')).toHaveLength(1);

        const second = await launchAppManually(intake, userDataDir);
        activeApp = second.electronApp;
        // A dump is deleted once its crash is processed, whether the crash is sent or dropped.
        await expect.poll(() => filesWithExtension(crashDumpsPath, '.dmp'), { timeout: 15 * ONE_SECOND }).toEqual([]);
        await second.mainPage.generateManualError();

        const errors = await second.mainPage.whileFlushing(() => intake.getSettledEventsByType('error'));
        expect(errors.filter(({ body }) => body.error.is_crash)).toHaveLength(sent ? 1 : 0);
      });
    }
  });
});

/** The texts found in at least one file under the directory. */
async function textsOnDisk(directory: string, texts: string[]): Promise<string[]> {
  const contents = await Promise.all((await listFiles(directory)).map((file) => readFile(file)));
  return texts.filter((text) => contents.some((content) => content.includes(text)));
}

async function filesWithExtension(directory: string, extension: string): Promise<string[]> {
  return (await listFiles(directory)).filter((file) => file.endsWith(extension));
}

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => join(entry.parentPath, entry.name));
}
