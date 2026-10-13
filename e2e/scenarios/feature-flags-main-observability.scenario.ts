import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { isMainProcessView } from '../lib/intake';

/**
 * Main-process feature flags observability: exposures are deduplicated across repeated
 * evaluations, RUM view documents pick up evaluated flags within the view update
 * throttle, and errors carry the flags evaluated before them.
 */
const flagsConfiguration = (intake: { getPort: () => number }) => ({
  evaluationMode: 'rules' as const,
  refreshInterval: 60_000,
  fetchTimeout: 2_000,
  flaggingProxy: `http://localhost:${intake.getPort()}`,
});
const PRO_CONTEXT = { targetingKey: 'user-pro', plan: 'pro' };

test.describe('feature flags observability (main)', () => {
  test('repeated main evaluations of the same flag produce one exposure', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      for (let i = 0; i < 3; i += 1) {
        await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
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

  test('context change produces a new exposure with the new targetingKey', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.setFlagsContext({ targetingKey: 'user-2', plan: 'pro' });
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');

      await mainPage.whileFlushing(() => intake.waitForExposureCount(2));
      const exposures = intake.getExposures();
      expect(exposures.map((exposure) => (exposure.body.subject as { id: string } | undefined)?.id)).toEqual([
        'user-pro',
        'user-2',
      ]);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('main view carries feature_flags within the view update throttle after an evaluation', async ({ intake }) => {
    test.setTimeout(40_000);
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');

      // The view document update is throttled (3s) but the flag shows up without
      // waiting for the 5-minute keepalive.
      await mainPage.whileFlushing(async () => {
        const views = await intake.getEventsByType('view', { predicate: isMainProcessView });
        const latest = views[views.length - 1];
        expect(latest.body.feature_flags).toEqual({ 'targeted-flag': 'variant-a' });
      }, 1_000);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('main error carries the flags evaluated before it', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.generateManualError();

      const errors = await mainPage.whileFlushing(async () => {
        const events = await intake.getEventsByType('error');
        const manualErrors = events.filter(
          (event) => (event.body.error as { message?: string } | undefined)?.message === 'test manual error'
        );
        expect(manualErrors).toHaveLength(1);
        return manualErrors;
      });
      expect(errors[0].body.feature_flags).toEqual({ 'targeted-flag': 'variant-a' });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('after session renewal the new main view starts without previous flags', async ({ intake }) => {
    test.setTimeout(40_000);
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      const flaggedViews = await mainPage.whileFlushing(
        () =>
          intake.getEventsByType('view', {
            predicate: (event) =>
              isMainProcessView(event) && event.body.feature_flags?.['targeted-flag'] === 'variant-a',
          }),
        1_000
      );
      const oldView = flaggedViews[flaggedViews.length - 1].body;
      const oldViewId = oldView.view.id;
      const oldSessionId = oldView.session.id;

      await mainPage.stopSession();
      await mainPage.generateActivity({ waitForPropagation: false });
      // A different view in the renewed session: it starts with no flags until a new evaluation.
      const renewedViews = await mainPage.whileFlushing(
        () =>
          intake.getEventsByType('view', {
            predicate: (event) =>
              isMainProcessView(event) && event.body.view.id !== oldViewId && event.body.session.id !== oldSessionId,
          }),
        1_000
      );
      expect(renewedViews.length).toBeGreaterThan(0);
      for (const view of renewedViews) {
        expect(view.body.feature_flags).toBeUndefined();
      }
      // The expired view kept its flags, through its final update.
      const oldViewDocuments = (await intake.getEventsByType('view', { predicate: isMainProcessView }))
        .filter((event) => event.body.view.id === oldViewId)
        .sort((a, b) => a.body._dd.document_version - b.body._dd.document_version);
      const finalOldView = oldViewDocuments[oldViewDocuments.length - 1].body;
      expect(finalOldView.session.id).toBe(oldSessionId);
      expect(finalOldView.feature_flags).toEqual({ 'targeted-flag': 'variant-a' });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('exposure intake failure does not affect evaluation', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      // First evaluation works with the intake healthy.
      const result = await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      expect(result.value).toBe('variant-a');
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1));
      // The exposures intake now fails: evaluations keep returning real values.
      intake.setExposuresMode('reject');
      const again = await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      expect(again.value).toBe('variant-a');
      await electronApp.close();
    } finally {
      intake.setExposuresMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('quitting the app sends the pending evaluation metrics (B7)', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      // No flush and no wait for the 10 s aggregation interval: the real quit path must send them.
      await electronApp.close();
      await intake.waitForFlagEvaluationCount(1, { timeout: 10_000 });
      const event = intake
        .getFlagEvaluations()
        .map((evaluation) => evaluation.body)
        .find((body) => (body.flag as { key: string }).key === 'targeted-flag');
      expect(event).toMatchObject({ evaluation_count: 2 });
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('evaluations are aggregated and sent', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      // Evaluate the same flag twice: the aggregator counts 2, not 1
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await mainPage.evaluateFlag('boolean', 'missing-flag', false);
      // The aggregator flushes every 10 s onto the flagevaluation track.
      await mainPage.whileFlushing(() => intake.waitForFlagEvaluationCount(2, { timeout: 20_000 }));
      const events = intake.getFlagEvaluations();
      expect(events.every((event) => event.ddforward.startsWith('/api/v2/flagevaluation?ddsource=electron'))).toBe(
        true
      );
      const byFlag = Object.fromEntries(
        events.map((event) => [(event.body.flag as { key: string }).key, event.body])
      ) as Record<string, Record<string, unknown>>;
      expect(byFlag['targeted-flag']).toMatchObject({
        variant: { key: 'variant-a' },
        allocation: { key: expect.any(String) as unknown },
        evaluation_count: 2,
        runtime_default_used: false,
        targeting_key: 'user-pro',
        context: {
          evaluation: { plan: 'pro' },
          dd: {
            service: 'e2e-test-app',
            rum: { application: { id: 'e2e-test-app-id' }, view: { url: 'electron://main-process' } },
          },
        },
      });
      expect(byFlag['missing-flag']).toMatchObject({
        evaluation_count: 1,
        runtime_default_used: true,
        error: { message: 'FLAG_NOT_FOUND' },
      });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});
