import { test, expect } from '../lib/helpers';
import type { RumErrorEvent } from '@datadog/electron-sdk';
import type { MainPage } from '../lib/mainPage';

interface Info {
  id: string;
  name?: string;
  email?: string;
  extraInfo?: Record<string, unknown>;
}

type Label = 'user' | 'account';
type EventKey = 'usr' | 'account';

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
  intake: { getEventsByType: (type: 'error') => Promise<{ body: unknown }[]> },
  eventKey: EventKey
): Promise<Record<string, unknown> | undefined> {
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;
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
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice', email: 'alice@example.com' });
});

test('attaches both user and account info to the same event', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });
  await mainPage.generateManualError();
  await mainPage.flushTransport();

  const errorEvents = await intake.getEventsByType('error');
  const error = errorEvents[0].body as RumErrorEvent;

  expect(error.usr).toEqual({ id: 'user-1', name: 'Alice' });
  expect(error.account).toEqual({ id: 'account-1', name: 'Acme Corp' });
});

test('enriches spans with usr.* tags when user context is set', async ({ mainPage, intake }) => {
  await mainPage.setUserInfo({ id: 'user-1', name: 'Alice' });

  await mainPage.mainPing();
  await mainPage.flushTransport();

  const span = await intake.waitForSpan((s) => s.name === 'electron.main.handle' && s.resource === 'ping');
  expect(span.meta['usr.id']).toBe('user-1');
  expect(span.meta['usr.name']).toBe('Alice');
});

test('enriches spans with account.* tags when account context is set', async ({ mainPage, intake }) => {
  await mainPage.setAccountInfo({ id: 'account-1', name: 'Acme Corp' });

  await mainPage.mainPing();
  await mainPage.flushTransport();

  const span = await intake.waitForSpan((s) => s.name === 'electron.main.handle' && s.resource === 'ping');
  expect(span.meta['account.id']).toBe('account-1');
  expect(span.meta['account.name']).toBe('Acme Corp');
});
