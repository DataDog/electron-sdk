import type { Page } from '@playwright/test';
import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';
import { FlagsChildren } from '../lib/mainPage';

/**
 * Main-process precomputed assignments (M7 default mode): Datadog computes the
 * assignments for the evaluation context, a context change re-fetches them, and a
 * per-context disk cache serves them across relaunches while the endpoint fails.
 */
const flagsConfiguration = (intake: { getPort: () => number }, overrides: Record<string, unknown> = {}) => ({
  refreshInterval: 60_000,
  fetchTimeout: 2_000,
  flaggingProxy: `http://localhost:${intake.getPort()}`,
  ...overrides,
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

/** Triggers a context change without waiting for its assignments fetch to settle. */
function fireAndForgetContext(page: Page, context: Record<string, unknown>) {
  return page.evaluate((ctx) => {
    void (
      globalThis as unknown as { electronAPI: { setFlagsContext: (context: unknown) => Promise<void> } }
    ).electronAPI.setFlagsContext(ctx);
  }, context);
}

test.describe('feature flags (precomputed)', () => {
  test('default mode fetches precomputed assignments with the context in the body', async ({ intake }) => {
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

      // The startup (anonymous) context and the registration context were both fetched.
      await intake.waitForPrecomputedRequestCount(2);
      const requests = intake.getPrecomputedRequests();
      // The startup request uses the anonymous key, not the registration context.
      expect(requests[0].targetingKey).not.toBe('user-pro');
      const [proRequest] = requests.filter((request) => request.targetingKey === 'user-pro');
      expect(proRequest).toBeDefined();
      // The targeting context is sent in the request body (string values as-is).
      expect(proRequest.targetingAttributes).toMatchObject({ plan: 'pro' });
      // No rules request is made in the default mode.
      expect(intake.getRulesRequests()).toHaveLength(0);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('the precomputed request carries the client token, env and application id', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      await intake.waitForPrecomputedRequestCount(2);

      const [request] = intake.getPrecomputedRequests();
      expect(request.headers['dd-client-token']).toBe('test-client-token');
      expect(request.headers['dd-application-id']).toBe('e2e-test-app-id');
      expect(request.url).toContain('dd_env=test');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('setContext re-fetches and main, a window and a child converge on the new assignments', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      expect((await children.call<boolean>('server-host', 'whenReady')).result).toBe(true);
      expect(await mainPage.evaluateFlag('string', 'targeted-flag', 'default')).toMatchObject({ value: 'variant-a' });
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');

      await mainPage.setFlagsContext({ targetingKey: 'user-free', plan: 'free' });
      expect(intake.getPrecomputedRequests().length).toBeGreaterThanOrEqual(3);

      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'default')).value).toBe('str-default');
      await expect.poll(async () => (await rendererEvaluate(window, 'targeted-flag')).value).toBe('str-default');
      await expect
        .poll(async () => (await children.evaluate('server-host', 'targeted-flag')).value)
        .toBe('str-default');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('while a context fetch is in flight, a changed targeting key serves defaults, an attribute-only change keeps serving', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    intake.setPrecomputedMode('slow');
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake, { fetchTimeout: 8_000 }),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      expect((await children.call<boolean>('server-host', 'whenReady')).result).toBe(true);
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      expect((await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');

      // A changed targeting key publishes defaults while the assignments are in flight,
      // so one identity never sees another identity's assignments. The invalidation
      // reaches every process: main, the renderer and the child all serve defaults.
      await fireAndForgetContext(window, { targetingKey: 'user-free', plan: 'free' });
      expect(await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).toMatchObject({
        value: 'app-default',
      });
      await expect.poll(async () => (await rendererEvaluate(window, 'targeted-flag')).value).toBe('default');
      await expect.poll(async () => (await children.evaluate('server-host', 'targeted-flag')).status).toBe('NOT_READY');
      await expect
        .poll(async () => (await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value, {
          timeout: 10_000,
        })
        .toBe('str-default');

      // An attribute-only change keeps serving the previous assignments until the new
      // ones arrive (upstream behavior).
      await fireAndForgetContext(window, { targetingKey: 'user-free', plan: 'pro' });
      expect(await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).toMatchObject({
        value: 'str-default',
      });
      await expect
        .poll(async () => (await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value, {
          timeout: 10_000,
        })
        .toBe('variant-a');
      await electronApp.close();
    } finally {
      intake.setPrecomputedMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a failed fetch for a new context serves its cache as STALE, and a context without one goes to ERROR with defaults', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      // First launch caches the assignments for the anonymous and the pro contexts.
      const first = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await first.mainPage.registerFlagsProvider(PRO_CONTEXT);
      await first.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default');
      // Let the async cache write complete before closing.
      await first.mainPage.flushTransport();
      await first.electronApp.close();

      // Second launch with a failing endpoint: the cached contexts are served as STALE.
      intake.setPrecomputedMode('error');
      const second = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await second.mainPage.registerFlagsProvider(PRO_CONTEXT);
      // The cached assignments for the same context are served while the network fails.
      expect((await second.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');

      // A context with no cached entry goes to ERROR with defaults (Q3).
      await second.mainPage.setFlagsContext({ targetingKey: 'user-stranger', plan: 'pro' }).catch(() => undefined);
      expect((await second.mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('app-default');
      await second.electronApp.close();
    } finally {
      intake.setPrecomputedMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('an authoritative 403 returns defaults and recovers on a later success', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    intake.setPrecomputedMode('forbidden');
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('app-default');

      intake.setPrecomputedMode('ok');
      // A context change re-fetches: the same targeting key alone would be a no-op (D20),
      // so the recovery goes through a changed context.
      await mainPage.setFlagsContext({ targetingKey: 'user-recovered', plan: 'pro' });
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'app-default')).value).toBe('variant-a');
      expect(await mainPage.getFlagsProviderStatus()).toBe('READY');
      await electronApp.close();
    } finally {
      intake.setPrecomputedMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('logout fetches for the anonymous key with a stable bucket across relaunch', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const first = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await first.mainPage.registerFlagsProvider({ targetingKey: 'user-1' });
      await first.mainPage.setFlagsContext({});
      const firstBucket = await first.mainPage.evaluateFlag('boolean', 'split-flag', true);
      await intake.waitForPrecomputedRequestCount(3);
      // Let the async anonymous-key and cache writes complete before closing.
      await first.mainPage.flushTransport();
      // The startup, registration and logout requests: the logout request carries the same anonymous key as the startup one.
      const firstRequests = intake.getPrecomputedRequests();
      expect(firstRequests[2].targetingKey).toBe(firstRequests[0].targetingKey);
      await first.electronApp.close();

      const second = await launchAppManually(intake, userDataDir, { featureFlags: flagsConfiguration(intake) });
      await second.mainPage.registerFlagsProvider({ targetingKey: 'user-2' });
      await second.mainPage.setFlagsContext({});
      const secondBucket = await second.mainPage.evaluateFlag('boolean', 'split-flag', true);
      await intake.waitForPrecomputedRequestCount(3);
      const secondRequests = intake.getPrecomputedRequests().slice(3);
      // The persisted anonymous key is reused across relaunches, so the bucket is stable.
      expect(secondRequests[2].targetingKey).toBe(firstRequests[0].targetingKey);
      expect(secondBucket.value).toBe(firstBucket.value);
      await second.electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });
});
