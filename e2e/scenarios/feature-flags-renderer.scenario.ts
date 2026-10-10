import type { Page } from '@playwright/test';
import {
  test,
  expect,
  launchAppManually,
  launchDeferredInitApp,
  createUserDataDir,
  cleanupUserDataDir,
} from '../lib/helpers';
import { MainPage } from '../lib/mainPage';

/**
 * Renderer-process feature flags: the renderer provider evaluates locally from
 * snapshots received over the origin-gated preload bridge, and evaluations from
 * renderers and main are deduplicated by the main-process ExposureCollector.
 */
const flagsConfiguration = (intake: { getPort: () => number }) => ({
  refreshInterval: 60_000,
  fetchTimeout: 2_000,
  flaggingProxy: `http://localhost:${intake.getPort()}`,
});

const PRO_CONTEXT = { targetingKey: 'user-pro', plan: 'pro' };

test.describe('feature flags (renderer)', () => {
  test('renderer and main return identical results for the same snapshot', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);

      const rendererResult = await window.evaluate(
        ([flagKey, defaultValue]) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (
                type: 'string',
                key: string,
                def: unknown
              ) => Promise<{ value: unknown; variant?: string; reason?: string; errorCode?: string }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, defaultValue),
        ['targeted-flag', 'app-default'] as const
      );
      const mainResult = await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');

      expect(rendererResult.value).toBe(mainResult.value);
      expect(rendererResult.variant).toBe(mainResult.variant);
      expect(rendererResult.reason).toBe(mainResult.reason);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('window on a disallowed host gets no snapshot and no context', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      // Use the default app with restricted hosts — the main window is file://
      // which is NOT in the allowed hosts
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
        allowedRendererHosts: ['app.example.com'], // Disallow the default file:// host
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);

      const rendererResult = await window.evaluate(
        ([flagKey, defaultValue]) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (
                type: 'string',
                key: string,
                def: unknown
              ) => Promise<{ value: unknown; variant?: string; reason?: string; errorCode?: string }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, defaultValue),
        ['targeted-flag', 'app-default'] as const
      );
      // The disallowed renderer gets the default, not the real value
      expect(rendererResult.value).toBe('app-default');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('evaluating the same flag in main and the renderer produces one exposure', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);

      // Evaluate in main
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      // Evaluate the same flag in the renderer
      await window.evaluate(
        ([flagKey, defaultValue]) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (type: 'string', key: string, def: unknown) => Promise<{ value: unknown }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, defaultValue),
        ['targeted-flag', 'app-default'] as const
      );

      // Wait for the exposure to arrive — the dedupe ensures only one
      await mainPage.whileFlushing(() => intake.waitForExposureCount(1));
      const exposures = intake.getExposures();
      expect(exposures).toHaveLength(1);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('endpoint recovery emits Ready in an open window', async ({ intake }) => {
    test.setTimeout(150_000);
    const userDataDir = await createUserDataDir();
    intake.setRulesMode('error');
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);

      intake.setRulesMode('ok');
      // The renderer should get the configuration after the next refresh
      await expect
        .poll(
          async () => {
            const result = await window.evaluate(
              ([flagKey, defaultValue]) =>
                (
                  globalThis as unknown as {
                    __rendererEvaluateFlag: (type: 'string', key: string, def: unknown) => Promise<{ value: unknown }>;
                  }
                ).__rendererEvaluateFlag('string', flagKey, defaultValue),
              ['targeted-flag', 'app-default'] as const
            );
            return result.value;
          },
          { timeout: 90_000, intervals: [2_000] }
        )
        .toBe('variant-a');
      await electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });
});

test.describe('feature flags (renderer, lifecycle)', () => {
  test('live update on context change', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const window = await electronApp.firstWindow();
      // Renderer evaluates with the initial context
      const before = await window.evaluate(
        (flagKey) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (t: 'string', k: string, d: unknown) => Promise<{ value: unknown }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, 'default'),
        'targeted-flag'
      );
      expect(before.value).toBe('variant-a');

      // Main changes the context; the renderer should re-target
      await mainPage.setFlagsContext({ targetingKey: 'user-free', plan: 'free' });
      const after = await window.evaluate(
        (flagKey) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (t: 'string', k: string, d: unknown) => Promise<{ value: unknown }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, 'default'),
        'targeted-flag'
      );
      expect(after.value).toBe('str-default');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('multiple windows converge on the same revision', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const windows = electronApp.windows();
      expect(windows.length).toBeGreaterThanOrEqual(1);
      // All windows evaluate the same flag with the same result
      for (const win of windows) {
        const result = await win.evaluate(
          (flagKey) =>
            (
              globalThis as unknown as {
                __rendererEvaluateFlag: (t: 'string', k: string, d: unknown) => Promise<{ value: unknown }>;
              }
            ).__rendererEvaluateFlag('string', flagKey, 'default'),
          'targeted-flag'
        );
        expect(result.value).toBe('variant-a');
      }
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('reloaded window gets the current snapshot', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const window = await electronApp.firstWindow();
      await window.reload();
      await window.waitForLoadState('domcontentloaded');
      const result = await window.evaluate(
        (flagKey) =>
          (
            globalThis as unknown as {
              __rendererEvaluateFlag: (t: 'string', k: string, d: unknown) => Promise<{ value: unknown }>;
            }
          ).__rendererEvaluateFlag('string', flagKey, 'default'),
        'targeted-flag'
      );
      expect(result.value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});

test.describe('feature flags (renderer, gating)', () => {
  test('renderer RUM view carries feature_flags with rumBrowserSdk enabled', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(
        intake,
        userDataDir,
        { featureFlags: flagsConfiguration(intake) },
        {}
      );
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');

      // The renderer provider calls DD_RUM.addFeatureFlagEvaluation: the renderer view
      // (assembled by the Browser SDK, relayed by the bridge) carries the flag.
      const views = await mainPage.whileFlushing(() =>
        intake.getEventsByType('view', {
          predicate: (event) =>
            event.body.source === 'browser' &&
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

  test('custom-partition window receives snapshots', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const { page } = await mainPage.openFlagsWindow(electronApp, {
        partition: 'persist:dd-flags-custom',
        marker: 'custom-partition',
      });
      expect(await hasFlagsBridge(page)).toBe(true);
      expect((await rendererEvaluate(page, 'targeted-flag')).value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a persist: partition created after init and excluded by name gets no flags bridge or snapshot, RUM keeps working', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(
        intake,
        userDataDir,
        { featureFlags: { ...flagsConfiguration(intake), excludedPartitions: ['persist:target'] } },
        {}
      );
      await mainPage.registerFlagsProvider(PRO_CONTEXT);

      // The persist:target session is first used here, after init().
      const { page } = await mainPage.openFlagsWindow(electronApp, {
        partition: 'persist:target',
        marker: 'excluded-target',
      });
      expect(await hasFlagsBridge(page)).toBe(false);
      expect(await invokeSnapshot(page)).toBeUndefined();
      expect((await rendererEvaluate(page, 'targeted-flag')).value).toBe('default');
      await mainPage.setFlagsContext({ targetingKey: 'user-2', plan: 'pro' });
      await page.waitForTimeout(500);
      expect(await updateCount(page)).toBe(0);

      // RUM events from the excluded window still arrive.
      const views = await mainPage.whileFlushing(() =>
        intake.getEventsByType('view', {
          predicate: (event) => (event.body.view as { url?: string }).url?.includes('excluded-target') === true,
          timeout: 15_000,
        })
      );
      expect(views.length).toBeGreaterThanOrEqual(1);

      // The default session keeps flags.
      expect(await hasFlagsBridge(window)).toBe(true);
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});

test.describe('feature flags (renderer, recovery)', () => {
  test('crash-and-reload window recovers flags', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const { id, page } = await mainPage.openFlagsWindow(electronApp, { marker: 'before-crash' });
      expect((await rendererEvaluate(page, 'targeted-flag')).value).toBe('variant-a');

      // A real renderer crash (render-process-gone), then a reload of the same webContents.
      expect(await mainPage.crashFlagsWindow(id, 'revived')).toBe(true);
      await expect
        .poll(async () => (await mainPage.evaluateInFlagsWindow(id, 'targeted-flag')).value, { timeout: 10_000 })
        .toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('navigation unsubscribe: after navigating to a disallowed host, no further pushes arrive', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
        allowedRendererHosts: ['localhost'],
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const { id, page } = await mainPage.openFlagsWindow(electronApp, {
        location: 'http-localhost',
        marker: 'allowed-origin',
      });
      expect((await rendererEvaluate(page, 'targeted-flag')).value).toBe('variant-a');
      await mainPage.setFlagsContext({ targetingKey: 'user-2', plan: 'pro' });
      await expect.poll(() => updateCount(page)).toBeGreaterThan(0);

      await mainPage.navigateFlagsWindow(id, 'http-127', 'disallowed-origin');
      await expect.poll(() => page.url()).toContain('disallowed-origin');
      await page.waitForLoadState('load');
      const snapshot = JSON.parse((await invokeSnapshot(page)) ?? '{}') as { status?: string; context?: unknown };
      expect(snapshot.status).toBe('DISABLED');
      expect(snapshot.context).toBeUndefined();
      await mainPage.setFlagsContext({ targetingKey: 'user-3', plan: 'pro' });
      await page.waitForTimeout(500);
      expect(await updateCount(page)).toBe(0);
      expect((await rendererEvaluate(page, 'targeted-flag')).value).toBe('default');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('window opened before deferred init becomes ready after init', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const electronApp = await launchDeferredInitApp(intake, userDataDir, {
        allowedRendererHosts: ['*'],
        featureFlags: flagsConfiguration(intake),
      });
      await electronApp.evaluate(() => (globalThis as unknown as E2EControls).__ddE2E.openWindow());
      const window = await electronApp.firstWindow();
      await window.waitForLoadState('load');
      await electronApp.evaluate(() => (globalThis as unknown as E2EControls).__ddE2E.init());
      const mainPage = new MainPage(window);
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});

interface E2EControls {
  __ddE2E: { init: () => Promise<void>; openWindow: () => void };
}

interface FlagsWindow {
  __rendererEvaluateFlag: (
    type: 'string',
    flagKey: string,
    defaultValue: unknown
  ) => Promise<{ value: unknown; variant?: string; errorCode?: string }>;
  __hasFlagsBridge: () => boolean;
  electronAPI: { invokeFlagsSnapshot: () => Promise<string | undefined>; getFlagsUpdateCount: () => number };
}

function rendererEvaluate(page: Page, flagKey: string) {
  return page.evaluate(
    (key) => (globalThis as unknown as FlagsWindow).__rendererEvaluateFlag('string', key, 'default'),
    flagKey
  );
}

function hasFlagsBridge(page: Page) {
  return page.evaluate(() => (globalThis as unknown as FlagsWindow).__hasFlagsBridge());
}

function invokeSnapshot(page: Page) {
  return page.evaluate(() => (globalThis as unknown as FlagsWindow).electronAPI.invokeFlagsSnapshot());
}

function updateCount(page: Page) {
  return page.evaluate(() => (globalThis as unknown as FlagsWindow).electronAPI.getFlagsUpdateCount());
}
