import type { Page } from '@playwright/test';
import {
  test,
  expect,
  launchAppManually,
  launchDeferredInitApp,
  createUserDataDir,
  cleanupUserDataDir,
} from '../lib/helpers';
import { FlagsChildren } from '../lib/mainPage';

/**
 * Feature flags in spawned processes (M6): forked ELECTRON_RUN_AS_NODE children over
 * app-routed frames, a utilityProcess and a worker over private ports. The SDK never
 * touches the app's own channels.
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

test.describe('feature flags (spawned processes)', () => {
  test('a forked ELECTRON_RUN_AS_NODE child evaluates the same result as main', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      expect((await children.call<boolean>('server-host', 'whenReady')).result).toBe(true);
      const child = await children.evaluate('server-host', 'targeted-flag');
      const main = await mainPage.evaluateFlag('string', 'targeted-flag', 'default');
      expect(child).toMatchObject({ value: main.value, variant: main.variant, status: 'READY' });
      expect(child.value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a child forked before deferred init returns the default with NOT_READY, then becomes READY after init', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const electronApp = await launchDeferredInitApp(intake, userDataDir, {
        allowedRendererHosts: ['*'],
        featureFlags: flagsConfiguration(intake),
      });
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      expect(await children.evaluate('server-host', 'targeted-flag')).toMatchObject({
        value: 'default',
        errorCode: 'PROVIDER_NOT_READY',
        status: 'NOT_READY',
      });
      await electronApp.evaluate(() =>
        (globalThis as unknown as { __ddE2E: { init: () => Promise<void> } }).__ddE2E.init()
      );
      expect((await children.call<boolean>('server-host', 'whenReady')).result).toBe(true);
      expect((await children.evaluate('server-host', 'targeted-flag')).status).toBe('READY');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('app handlers never receive an SDK message; every correlated ping reply matches its id', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      await mainPage.setFlagsContext({ targetingKey: 'user-2', plan: 'pro' });
      await children.evaluate('server-host', 'targeted-flag');
      const replies = await Promise.all(
        Array.from({ length: 10 }, (_, n) => children.call<{ n: number }>('server-host', 'ping', { n }))
      );
      for (const [n, reply] of replies.entries()) {
        expect(reply.result.n).toBe(n);
      }
      const status = (await children.call<{ appMessages: number; sdkEnvelopesSeen: number }>('server-host', 'status'))
        .result;
      expect(status.sdkEnvelopesSeen).toBe(0);
      // Only the app's own requests reached its handler: whenReady, evaluate, 10 pings, status.
      expect(status.appMessages).toBe(13);
      const { listeners } = await children.state();
      // The app's own 'message' handler, and the SDK's owner.once('exit'): the only listener it adds.
      expect(listeners['server-host']).toEqual({ message: 1, exit: 1 });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a child context request re-targets main, a renderer window and the child', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, window, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider({ targetingKey: 'user-free', plan: 'free' });
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('str-default');
      const response = await children.call<{ accepted: boolean; contextRevision?: number }>(
        'server-host',
        'requestContext',
        { context: PRO_CONTEXT }
      );
      expect(response.result.accepted).toBe(true);
      expect((await mainPage.evaluateFlag('string', 'targeted-flag', 'default')).value).toBe('variant-a');
      await expect.poll(async () => (await rendererEvaluate(window, 'targeted-flag')).value).toBe('variant-a');
      await expect.poll(async () => (await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a killed and re-forked child receives the current snapshot; the old channel closed and one channel remains', async ({
    intake,
  }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      const firstPid = await children.fork('server-host');
      await children.call('server-host', 'whenReady');
      await mainPage.setFlagsContext({ targetingKey: 'user-3', plan: 'pro' });
      const secondPid = await children.killAndRefork('server-host');
      expect(secondPid).not.toBe(firstPid);
      expect((await children.call<boolean>('server-host', 'whenReady')).result).toBe(true);
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      expect((await children.state()).openChannels).toBe(1);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a utilityProcess child and a worker_threads worker evaluate over their private ports', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      expect(await children.spawnUtility()).toMatchObject({ ready: true, value: 'variant-a' });
      expect((await children.spawnWorker('serve')).result).toMatchObject({ ready: true, value: 'variant-a' });
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a worker whose only remaining handle is the flags port exits naturally', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const outcome = await new FlagsChildren(electronApp).spawnWorker('once');
      expect(outcome.result).toMatchObject({ ready: true, value: 'variant-a' });
      expect(outcome.exited).toBe(true);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('a child connected with no endpoint returns defaults and does not crash', async ({ intake }) => {
    const userDataDir = await createUserDataDir();
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('standalone', 'none');
      expect(await children.evaluate('standalone', 'targeted-flag')).toMatchObject({
        value: 'default',
        errorCode: 'PROVIDER_NOT_READY',
        status: 'NOT_READY',
      });
      expect((await children.call<{ n: number }>('standalone', 'ping', { n: 7 })).result.n).toBe(7);
      await electronApp.close();
    } finally {
      await cleanupUserDataDir(userDataDir);
    }
  });

  test('endpoint recovery reaches an open child channel (status READY)', async ({ intake }) => {
    test.setTimeout(150_000);
    const userDataDir = await createUserDataDir();
    intake.setRulesMode('error');
    try {
      const { mainPage, electronApp } = await launchAppManually(intake, userDataDir, {
        featureFlags: flagsConfiguration(intake),
      });
      await mainPage.registerFlagsProvider(PRO_CONTEXT);
      const children = new FlagsChildren(electronApp);
      await children.fork('server-host');
      expect((await children.evaluate('server-host', 'targeted-flag')).status).toBe('ERROR');
      intake.setRulesMode('ok');
      await expect
        .poll(async () => (await children.evaluate('server-host', 'targeted-flag')).status, {
          timeout: 90_000,
          intervals: [2_000],
        })
        .toBe('READY');
      expect((await children.evaluate('server-host', 'targeted-flag')).value).toBe('variant-a');
      await electronApp.close();
    } finally {
      intake.setRulesMode('ok');
      await cleanupUserDataDir(userDataDir);
    }
  });
});
