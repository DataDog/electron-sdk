import { test, expect } from '../lib/helpers';
import type { ElectronApplication } from '@playwright/test';
import type { RumViewEvent } from '@datadog/electron-sdk';
import type { MainPage } from '../lib/mainPage';

function isBridgeView(event: { body: unknown }): boolean {
  return (event.body as RumViewEvent).view.url !== 'electron://main-process';
}

interface Scenario {
  name: string;
  hosts: string[];
  openWindow: (mainPage: MainPage, app: ElectronApplication) => Promise<unknown>;
  expectEvents: boolean;
}

const SCENARIOS: Scenario[] = [
  {
    name: 'http renderer — allowed',
    hosts: ['localhost'],
    openWindow: (p, a) => p.openBridgeHttpWindow(a),
    expectEvents: true,
  },
  {
    name: 'http renderer — blocked',
    hosts: ['file://'],
    openWindow: (p, a) => p.openBridgeHttpWindow(a),
    expectEvents: false,
  },
  {
    name: 'file:// renderer — allowed',
    hosts: ['file://'],
    openWindow: (p, a) => p.openBridgeFileWindow(a),
    expectEvents: true,
  },
  {
    name: 'file:// renderer — blocked',
    hosts: ['localhost'],
    openWindow: (p, a) => p.openBridgeFileWindow(a),
    expectEvents: false,
  },
  {
    name: 'custom protocol (app://) — allowed',
    hosts: ['bridge'],
    openWindow: (p, a) => p.openBridgeAppProtocolWindow(a),
    expectEvents: true,
  },
  {
    name: 'wildcard allows http://',
    hosts: ['*'],
    openWindow: (p, a) => p.openBridgeHttpWindow(a),
    expectEvents: true,
  },
  {
    name: 'wildcard allows file://',
    hosts: ['*'],
    openWindow: (p, a) => p.openBridgeFileWindow(a),
    expectEvents: true,
  },
];

for (const scenario of SCENARIOS) {
  test.describe(`allowedRendererHosts — ${scenario.name}`, () => {
    test.use({ sdkConfigOverrides: { allowedRendererHosts: scenario.hosts } });

    if (scenario.expectEvents) {
      test('bridge events arrive from an allowed renderer', async ({ electronApp, mainPage, intake }) => {
        await mainPage.flushTransport();
        await intake.getEventsByType('view');

        await scenario.openWindow(mainPage, electronApp);
        await mainPage.flushTransport();

        const bridgeViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
        expect(bridgeViews).toHaveLength(1);
      });
    } else {
      test('no bridge events arrive from a blocked renderer', async ({ electronApp, mainPage, intake }) => {
        await mainPage.flushTransport();
        await intake.getEventsByType('view');

        await scenario.openWindow(mainPage, electronApp);
        await mainPage.flushTransport();
        await new Promise((r) => setTimeout(r, 2000));

        const bridgeViews = (await intake.getEventsByType('view')).filter(isBridgeView);
        expect(bridgeViews).toHaveLength(0);
      });
    }
  });
}
