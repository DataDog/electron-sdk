import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import type { Page } from '@playwright/test';

/**
 * Precomputed feature flags observability: exposures are deduplicated per
 * (subject, flag, variant, createdAt) — the precomputed configuration identity — and a
 * new createdAt re-logs (D29).
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

test.describe('feature flags observability (precomputed)', () => {
  test('repeated evaluations in main and a window produce one exposure per configuration identity', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      for (let i = 0; i < 3; i += 1) {
        await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
        await rendererEvaluate(window, 'targeted-flag');
      }
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1));
      const exposures = intake.getExposures();
      expect(exposures).toHaveLength(1);
      expect(exposures[0].body).toMatchObject({
        flag: { key: 'targeted-flag' },
        variant: { key: 'variant-a' },
        subject: { id: 'user-pro' },
      });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a new createdAt re-logs the exposure for the same flag and context', async ({ intake }) => {
    test.setTimeout(150_000);
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1));

      // The refresh re-fetches the current context: the response carries a new createdAt,
      // so the next evaluation is a new exposure even for the same flag, variant and subject.
      await mainPage.whileFlushing(() => intake.waitForPrecomputedRequestCount(3, { timeout: 120_000 }));
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.whileFlushing(() => intake.waitForExposureCount(2));
      const exposures = intake.getExposures();
      expect(exposures).toHaveLength(2);
      for (const exposure of exposures) {
        expect(exposure.body).toMatchObject({
          flag: { key: 'targeted-flag' },
          variant: { key: 'variant-a' },
          subject: { id: 'user-pro' },
        });
      }
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});
