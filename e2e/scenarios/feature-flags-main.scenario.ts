import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';

/**
 * Main-process feature flags: the provider is the only way to set the context, rules are
 * fetched with the client token only, and the configuration is cached on disk scoped by
 * environment so a relaunch can serve it while the endpoint fails.
 */
const flagsConfiguration = (intake: { getPort: () => number }, overrides: Record<string, unknown> = {}) => ({
  refreshInterval: 60_000,
  fetchTimeout: 2_000,
  flaggingProxy: `http://localhost:${intake.getPort()}`,
  ...overrides,
});

const PRO_CONTEXT = { targetingKey: 'user-pro', plan: 'pro' };

test.describe('feature flags (main)', () => {
  test('main evaluates a targeted flag after READY', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });

      const status = await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect(status).toBe('READY');

      const result = await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      expect(result.value).toBe('variant-a');
      expect(result.variant).toBe('variant-a');
      expect(result.reason).toBe('STATIC');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('context change re-targets without a new configuration request', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');
      await intake.waitForRulesRequestCount(1);

      await mainPage.setFlagsContext({ targetingKey: 'user-free', plan: 'free' });
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('str-default');

      // A context change is evaluated locally: no new configuration request.
      expect(intake.getRulesRequests()).toHaveLength(1);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('logout falls back to the anonymous key with a stable bucket across relaunch with the same userData', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const first = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await first.mainPage.registerFlagsProvider({ targetingKey: 'user-1' });
      await first.mainPage.setFlagsContext({});
      const firstBucket = await first.mainPage.evaluateFlag('boolean', 'split-flag', true);
      await first.electronApp.close();

      const second = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await second.mainPage.registerFlagsProvider();
      await second.mainPage.setFlagsContext({});
      const secondBucket = await second.mainPage.evaluateFlag('boolean', 'split-flag', true);
      // The anonymous key is persisted: the bucket is stable across relaunches.
      expect(secondBucket.value).toBe(firstBucket.value);
      await second.electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('configuration request carries the client token and env but no context attributes', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      await intake.waitForRulesRequestCount(1);

      const request = intake.getRulesRequests()[0];
      expect(request.headers['dd-client-token']).toBe('test-client-token');
      expect(request.url).toContain('dd_env=test');
      // The targeting context never leaves the device.
      expect(request.url).not.toContain('user-pro');
      expect(request.url).not.toContain('plan');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('unreachable configuration endpoint returns defaults within fetchTimeout and the app stays responsive', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    intake.setRulesMode('hang');
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake, { fetchTimeout: 1_000 }),
      });
      const startedAt = Date.now();
      const result = await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      expect(Date.now() - startedAt).toBeLessThan(10_000);
      expect(result.value).toBe('app-default');
      // The app is still responsive.
      expect(await mainPage.mainPing()).toBe('pong');
      await electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('endpoint recovery emits Ready and returns real values without restart', async ({ intake }) => {
    test.setTimeout(150_000);
    const userDataDir = await createUserDataDir();
    intake.setRulesMode('error');
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake, { refreshInterval: 60_000 }),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('app-default');

      intake.setRulesMode('ok');
      // The next refresh recovers and serves real values without restarting the app.
      await expect
        .poll(async () => (await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value, {
          timeout: 90_000,
          intervals: [2_000],
        })
        .toBe('variant-a');
      expect(await mainPage.getFlagsProviderStatus()).toBe('READY');
      await electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('second launch with the same userData and a failing endpoint serves cached values', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const first = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await first.mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await first.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');
      // Let the async cache write complete before closing.
      await first.mainPage.flushTransport();
      await first.electronApp.close();

      intake.setRulesMode('error');
      const second = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await second.mainPage.registerFlagsProvider(PRO_CONTEXT);
      // The cached configuration is served while the network fails.
      expect((await second.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');
      await second.electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('changing env ignores the cache', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const first = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await first.mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await first.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');
      // Let the async cache write complete before closing.
      await first.mainPage.flushTransport();
      await first.electronApp.close();

      intake.setRulesMode('error');
      const second = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake, { env: 'other-env' }),
      });
      // The cache is scoped by environment: a different env does not serve the stale one.
      await second.mainPage.registerFlagsProvider(PRO_CONTEXT);
      const result = await second.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      expect(result.value).toBe('app-default');
      await second.electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });
});
