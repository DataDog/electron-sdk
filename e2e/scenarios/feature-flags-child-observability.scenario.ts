import type { Page } from '@playwright/test';
import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { FlagsChildren } from '../lib/mainPage';
import { isMainProcessView } from '../lib/intake';

/**
 * Observability of spawned-process evaluations (M6, D19): attributed to the main process,
 * deduplicated with main and renderer exposures by main, counted in evaluation metrics.
 */
const flagsConfiguration = (intake: { getPort: () => number }) => ({
  refreshInterval: 60_000,
  fetchTimeout: 2_000,
  flaggingProxy: `http://localhost:${intake.getPort()}`,
});

const PRO_CONTEXT = { targetingKey: 'user-pro', plan: 'pro' };

function rendererEvaluate(page: Page, flagKey: string) {
  return page.evaluate(
    (key) =>
      (
        globalThis as unknown as {
          __rendererEvaluateFlag: (type: 'string', k: string, d: unknown) => Promise<{ value: unknown }>;
        }
      ).__rendererEvaluateFlag('string', key, 'default'),
    flagKey
  );
}

test.describe('feature flags observability (spawned processes)', () => {
  test('evaluating the same flag in main, a window and a child produces one exposure', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      await mainPage.evaluateFlag('string', 'targeted-flag', 'default');
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      // Child and renderer records flush within 1 s; flush main while waiting.
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1));
      await window.waitForTimeout(2_000);
      await mainPage.flushTransport();
      expect(intake.getExposures()).toHaveLength(1);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test("child exposures carry electron://main-process and the main view carries the child's flag", async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1, { timeout: 10_000 }));
      const exposure = intake.getExposures()[0].body as { rum: { view: { url: string } }; flag: { key: string } };
      expect(exposure.flag.key).toBe('targeted-flag');
      expect(exposure.rum.view.url).toBe('electron://main-process');
      const views = await mainPage.whileFlushing(() =>
        intake.getEventsByType('view', {
          predicate: (event) =>
            isMainProcessView(event) &&
            (event.body as { feature_flags?: Record<string, unknown> }).feature_flags?.['targeted-flag'] ===
              'variant-a',
          timeout: 15_000,
        })
      );
      expect(views.length).toBeGreaterThanOrEqual(1);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('child evaluations are counted in evaluation metrics', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      await children.evaluate('server-host', 'targeted-flag');
      await children.evaluate('server-host', 'targeted-flag');
      await mainPage.whileFlushing(() => intake.waitForFlagEvaluationCount(1, { timeout: 25_000 }));
      const event = intake
        .getFlagEvaluations()
        .map((evaluation) => evaluation.body)
        .find((body) => (body.flag as { key: string }).key === 'targeted-flag')!;
      expect(event).toMatchObject({
        evaluation_count: 2,
        context: { dd: { rum: { view: { url: 'electron://main-process' } } } },
      });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});
