import { test, expect } from '../lib/helpers';
import type { Intake } from '../lib/intake';
import type { MainPage } from '../lib/mainPage';
import { isMainProcessEvent } from '../lib/intake';

interface Info {
  id: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}

type Label = 'user' | 'account';
type EventKey = 'usr' | 'account' | 'context';

interface Scenario {
  label: Label;
  eventKey: EventKey;
}

const scenarios: Scenario[] = [
  { label: 'user', eventKey: 'usr' },
  { label: 'account', eventKey: 'account' },
];

const INITIAL_INFO: Info = { id: 'customer-1', name: 'Alice' };

/** Derives the set/clear/extra-info operations for a customer from the MainPage `set${Label}Info` naming convention. */
function getOps(mainPage: MainPage, label: Label) {
  const cap = label.charAt(0).toUpperCase() + label.slice(1);
  const page = mainPage as unknown as Record<string, (...args: unknown[]) => Promise<void>>;
  return {
    setInfo: (info: Info) => page[`set${cap}Info`](info),
    clearInfo: () => page[`clear${cap}Info`](),
    addExtraInfo: (extraInfo: Record<string, unknown>) => page[`add${cap}ExtraInfo`](extraInfo),
  };
}

async function getContext(
  mainPage: MainPage,
  intake: Pick<Intake, 'getEventsByType'>,
  eventKey: EventKey
): Promise<Record<string, unknown> | undefined> {
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body;
  return error[eventKey];
}

for (const { label, eventKey } of scenarios) {
  test(`attaches ${label} info to subsequent events`, async ({ mainPage, intake }) => {
    await getOps(mainPage, label).setInfo(INITIAL_INFO);

    const context = await getContext(mainPage, intake, eventKey);

    expect(context).toEqual(INITIAL_INFO);
  });

  test(`clears ${label} info from subsequent events`, async ({ mainPage, intake }) => {
    const ops = getOps(mainPage, label);
    await ops.setInfo({ id: INITIAL_INFO.id });
    await ops.clearInfo();

    const context = await getContext(mainPage, intake, eventKey);

    expect(context).toBeUndefined();
  });

  test(`does not attach ${eventKey} when no ${label} is set`, async ({ mainPage, intake }) => {
    const context = await getContext(mainPage, intake, eventKey);

    expect(context).toBeUndefined();
  });

  test(`adds ${label} extra info to subsequent events`, async ({ mainPage, intake }) => {
    const ops = getOps(mainPage, label);
    await ops.setInfo(INITIAL_INFO);
    await ops.addExtraInfo({ plan: 'premium' });

    const context = await getContext(mainPage, intake, eventKey);

    expect(context).toMatchObject({ id: INITIAL_INFO.id, plan: 'premium' });
  });
}

test('attaches user email to subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });
});

test('attaches both user and account info to the same event', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice' });
  expect(error.account).toEqual({ id: 'account-1', name: 'Acme Corp' });
});

test('enriches spans with usr.* tags when user context is set', async ({ mainPage, intake, testServer }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });

  const url = testServer.urlFor(200);
  await mainPage.mainNetFetch(url);
  await mainPage.flushTransport();

  const span = await intake.waitForSpan((s) => s.name === 'http.request' && s.meta['http.url'] === url);
  expect(span.meta['usr.id']).toBe('user-1');
  expect(span.meta['usr.name']).toBe('Alice');
});

test('enriches spans with account.* tags when account context is set', async ({ mainPage, intake, testServer }) => {
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });

  const url = testServer.urlFor(200);
  await mainPage.mainNetFetch(url);
  await mainPage.flushTransport();

  const span = await intake.waitForSpan((s) => s.name === 'http.request' && s.meta['http.url'] === url);
  expect(span.meta['account.id']).toBe('account-1');
  expect(span.meta['account.name']).toBe('Acme Corp');
});

test('attaches the global context to subsequent events', async ({ mainPage, intake }) => {
  await mainPage.setGlobalContext({ team: 'checkout' });
  await mainPage.setGlobalContextProperty('build', '1.2.3');

  const context = await getContext(mainPage, intake, 'context');

  expect(context).toMatchObject({ team: 'checkout', build: '1.2.3' });
});

test('merges the global context with addError context, event keys winning', async ({ mainPage, intake }) => {
  await mainPage.setGlobalContext({ team: 'checkout', source: 'global' });
  await mainPage.generateManualError(undefined, { source: 'error', requestId: 'request-1' });
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  expect(errorEvents[0].body.context).toEqual({
    team: 'checkout',
    source: 'error',
    requestId: 'request-1',
  });
});

test('merges the global context into renderer events, renderer keys winning', async ({
  electronApp,
  mainPage,
  intake,
}) => {
  await mainPage.setGlobalContext({ team: 'checkout', build: '1.2.3' });

  const bridgeWindow = await mainPage.openBridgeHttpWindow(electronApp);
  await bridgeWindow.setRendererGlobalContext({ team: 'renderer-owned' });
  await bridgeWindow.generateError('renderer error');
  await mainPage.flushTransport();

  const errors = await intake.getEventsByType('error', {
    predicate: (event) => event.body.error.message === 'renderer error',
  });
  expect(errors[0].body).toMatchObject({
    context: { team: 'renderer-owned', build: '1.2.3' },
  });
});

test.describe('feature flag evaluations', () => {
  test('updates the main view immediately and tags only main views and errors by default', async ({
    mainPage,
    intake,
    testServer,
  }) => {
    await mainPage.addFeatureFlagEvaluation('new_search', false);
    await mainPage.addFeatureFlagEvaluation('new_search', true);
    await mainPage.generateManualError();
    await mainPage.mainFetch(testServer.urlFor(200));
    await mainPage.addDurationVital('search', { startTime: Date.now(), duration: 25 });
    await mainPage.flushTransport();

    const [error] = await intake.getEventsByType('error');
    expect(error.body.feature_flags).toEqual({ new_search: true });
    const [view] = await intake.getEventsByType('view', {
      predicate: (event) => isMainProcessEvent(event) && event.body.feature_flags?.new_search === true,
    });
    expect(view.body.view.id).toBe(error.body.view.id);
    expect(view.body.view.is_active).toBe(true);
    const [resource] = await intake.getEventsByType('resource');
    const [vital] = await intake.getEventsByType('vital');
    expect(resource.body.feature_flags).toBeUndefined();
    expect(vital.body.feature_flags).toBeUndefined();
  });

  test('clears flags on refusal and ignores evaluations made while consent is refused', async ({
    mainPage,
    intake,
  }) => {
    await mainPage.addFeatureFlagEvaluation('new_search', true);
    await mainPage.setTrackingConsent('not-granted');
    await mainPage.addFeatureFlagEvaluation('refused_flag', true);
    await mainPage.setTrackingConsent('granted');
    await mainPage.generateManualError();
    await mainPage.flushTransport();

    const [error] = await intake.getEventsByType('error');
    expect(error.body.feature_flags).toBeUndefined();
    const [view] = await intake.getEventsByType('view', {
      predicate: (event) => isMainProcessEvent(event) && event.body.view.id === error.body.view.id,
    });
    expect(view.body.feature_flags).toBeUndefined();
  });

  test('preserves Browser RUM flags on renderer views and errors independently of main flags', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    await mainPage.addFeatureFlagEvaluation('main_only', true);
    await mainPage.addFeatureFlagEvaluation('new_search', true);
    const bridge = await mainPage.openBridgeHttpWindow(electronApp);
    await bridge.addFeatureFlagEvaluation('new_search', false);
    await bridge.generateError('renderer flag error');

    const [error] = await mainPage.whileFlushing(() =>
      intake.getEventsByType('error', { predicate: (event) => event.body.error.message === 'renderer flag error' })
    );
    expect(error.body.feature_flags).toEqual({ new_search: false });
    const [view] = await mainPage.whileFlushing(() =>
      intake.getEventsByType('view', {
        predicate: (event) =>
          event.body.view.id === error.body.view.id && event.body.feature_flags?.new_search === false,
      })
    );
    expect(view.body.feature_flags).toEqual({ new_search: false });
  });

  test.describe('with resources and vitals enabled', () => {
    test.use({ sdkConfigOverrides: { trackFeatureFlagsForEvents: ['resource', 'vital'] } });

    test('enriches main resources and duration and operation vitals with the same flag context', async ({
      mainPage,
      intake,
      testServer,
    }) => {
      await mainPage.addFeatureFlagEvaluation('new_search', true);
      const url = testServer.urlFor(200);
      await mainPage.mainFetch(url);
      await mainPage.addDurationVital('search', { startTime: Date.now(), duration: 25 });
      await mainPage.startOperation('search');
      await mainPage.flushTransport();

      const [resource] = await intake.getEventsByType('resource', {
        predicate: (event) => event.body.resource.url === url,
      });
      const vitals = await intake.waitForEventCount('vital', 2);
      expect(resource.body.feature_flags).toEqual({ new_search: true });
      expect(vitals.map(({ body }) => body.vital?.type).sort()).toEqual(['duration', 'operation_step']);
      for (const { body } of vitals) {
        expect(body.feature_flags).toEqual({ new_search: true });
      }
    });
  });
});
