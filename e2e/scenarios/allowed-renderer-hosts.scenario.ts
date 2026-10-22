import { test, expect } from '../lib/helpers';
import { isBridgeView } from '../lib/intake';
import type { ElectronApplication } from '@playwright/test';
import type { MainPage } from '../lib/mainPage';

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
    name: 'custom protocol (app://) — blocked',
    hosts: ['other'],
    openWindow: (p, a) => p.openBridgeAppProtocolWindow(a),
    expectEvents: false,
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

// Lifecycle test: open → receive events → close → reopen → receive events again.
// Verifies that:
// (a) the frame tracking set is populated on first allowed message,
// (b) the 'destroyed' cleanup fires when the window closes without corrupting state,
// (c) a new window for the same host is correctly allowed after cleanup.
// The null-senderFrame race (message arriving after frame destruction) is non-deterministic
// in e2e, so that code path is covered by unit tests; this test owns the lifecycle contract.
test.describe('allowedRendererHosts — frame tracking lifecycle', () => {
  test.use({ sdkConfigOverrides: { allowedRendererHosts: ['localhost'] } });

  test('bridge events arrive before and after closing a window', async ({ electronApp, mainPage, intake }) => {
    await mainPage.flushTransport();
    await intake.getEventsByType('view');

    const win1 = await mainPage.openBridgeHttpWindow(electronApp);
    await mainPage.flushTransport();
    const firstViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    expect(firstViews).toHaveLength(1);

    // Close window — triggers 'destroyed' on the WebContents, evicting the frame from allowedFrames.
    // flushTransport is an IPC round-trip to the main process; by the time it resolves, the
    // 'destroyed' handler has already fired (Node.js event loop is single-threaded).
    await win1.page.close();
    await mainPage.flushTransport();

    // Clear stale events so the next assertion only sees events from the new window
    intake.clear();

    // Re-open a new window of the same type; a fresh frame must be correctly allowed
    await mainPage.openBridgeHttpWindow(electronApp);
    await mainPage.flushTransport();
    const secondViews = await intake.waitForEventCount('view', 1, { predicate: isBridgeView });
    expect(secondViews.length).toBeGreaterThanOrEqual(1);
  });
});

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
