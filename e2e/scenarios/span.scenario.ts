import { test, expect } from '../lib/helpers';
import type { RumViewEvent } from '@datadog/electron-sdk';
import type { MainPage } from '../lib/mainPage';

const ipcSpanCases: {
  title: string;
  trigger: (mainPage: MainPage) => Promise<unknown>;
  spanName: string;
  resource: string;
  spanKind: string;
}[] = [
  {
    title: 'electron.main.handle when ipcMain.handle listener is invoked',
    trigger: (mainPage) => mainPage.mainPing(),
    spanName: 'electron.main.handle',
    resource: 'ping',
    spanKind: 'consumer',
  },
  {
    title: 'electron.main.receive when ipcMain.on listener is invoked',
    trigger: (mainPage) => mainPage.mainFireAndForget(),
    spanName: 'electron.main.receive',
    resource: 'mainFireAndForget',
    spanKind: 'consumer',
  },
  {
    title: 'electron.main.send when webContents.send is called',
    trigger: (mainPage) => mainPage.triggerMainSend(),
    spanName: 'electron.main.send',
    resource: 'mainPush',
    spanKind: 'producer',
  },
];

for (const { title, trigger, spanName, resource, spanKind } of ipcSpanCases) {
  test(`emits an ${title} span with Electron context`, async ({ mainPage, intake }) => {
    await mainPage.flushTransport();
    const viewEvents = await intake.getEventsByType('view');
    const view = viewEvents[0].body as RumViewEvent;

    await trigger(mainPage);
    await mainPage.flushTransport();

    const span = await intake.waitForSpan((s) => s.name === spanName && s.resource === resource);
    expect(span.meta['span.kind']).toBe(spanKind);
    expect(span.meta['_dd.application.id']).toBe(view.application.id);
    expect(span.meta['_dd.session.id']).toBe(view.session.id);
    expect(span.meta['_dd.view.id']).toBe(view.view.id);
    expect(span.service).toBe('e2e-test-app');
  });
}

test('electron.main.send span is parented to the electron.main.handle span that triggers it', async ({
  mainPage,
  intake,
}) => {
  await mainPage.flushTransport();

  // triggerMainSend is an ipcMain.handle that calls webContents.send('mainPush') from inside
  // the handler, so the producer span must share the trace of the consumer handle span.
  await mainPage.triggerMainSend();
  await mainPage.flushTransport();

  const handleSpan = await intake.waitForSpan(
    (s) => s.name === 'electron.main.handle' && s.resource === 'triggerMainSend'
  );
  const sendSpan = await intake.waitForSpan((s) => s.name === 'electron.main.send' && s.resource === 'mainPush');

  expect(sendSpan.trace_id).toBe(handleSpan.trace_id);
  expect(sendSpan.parent_id).toBe(handleSpan.span_id);
});
