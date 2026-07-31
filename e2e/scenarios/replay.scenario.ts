import type { ElectronApplication } from '@playwright/test';
import { test, expect } from '../lib/helpers';
import type { Intake } from '../lib/intake';
import type { MainPage } from '../lib/mainPage';

/**
 * Session replay E2E scenarios.
 *
 * These tests verify that:
 * 1. The Electron SDK preload exposes "records" capability so the browser RUM SDK
 *    starts emitting BrowserRecord events through the bridge.
 * 2. ReplayCollection buffers those records and emits a compressed segment.
 * 3. ReplayBatchConsumer uploads the segment as multipart/form-data and the
 *    mock intake receives it with correct metadata.
 * 4. The main-process `defaultPrivacyLevel` reaches the renderer recorder through the
 *    bridge: masked text is absent from the recorded segment, unmasked text is present.
 */

// A distinctive token rendered into the bridge window's DOM. It appears verbatim in the
// recorded rrweb nodes only when text is NOT masked, making it a reliable probe for whether
// the privacy level was honoured end-to-end.
const SENSITIVE_TEXT = 'SensitiveReplayValue42';

/**
 * Opens a bridge window, renders {@link SENSITIVE_TEXT} into it (triggering an rrweb mutation
 * record), flushes the transport, and returns the concatenated JSON of every decoded segment's
 * records so a test can assert on the recorded text.
 */
async function recordSensitiveTextAndFlush(
  electronApp: ElectronApplication,
  mainPage: MainPage,
  intake: Intake
): Promise<string> {
  const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
  expect(await bridgeWindow.getBridgeCapabilities()).toContain('records');

  await bridgeWindow.page.evaluate((text) => {
    // Runs in the renderer; the e2e tsconfig has no DOM lib, so reach `document` via globalThis
    // (same cast pattern as BridgeWindowPage.getBridgeCapabilities).
    const { document } = globalThis as unknown as {
      document: {
        createElement(tag: string): { textContent: string };
        body: { appendChild(node: unknown): void };
      };
    };
    const el = document.createElement('p');
    el.textContent = text;
    document.body.appendChild(el);
  }, SENSITIVE_TEXT);

  // Give the recorder time to emit the mutation and buffer it into the segment.
  await bridgeWindow.page.waitForTimeout(2000);
  await mainPage.flushTransport();

  // Wait for a segment whose blob we could actually decode into records.
  await intake.waitForReplaySegment({ timeout: 20_000, predicate: (s) => (s.records?.length ?? 0) > 0 });

  return JSON.stringify(intake.getReplaySegments().map((s) => s.records ?? []));
}

test.describe('session replay', () => {
  test('replay segment arrives at the intake after opening a bridge window', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    // Open a bridge window — the browser RUM SDK initialises and, because the
    // Electron SDK preload advertises "records" capability, starts recording rrweb events.
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    expect(await bridgeWindow.getBridgeCapabilities()).toContain('records');

    // Give the renderer time to produce at least one full-snapshot record.
    await bridgeWindow.page.waitForTimeout(2000);

    // Flush forces ReplayCollection to flush the current segment, compress it,
    // and push it through the batch pipeline to the intake.
    await mainPage.flushTransport();

    const segment = await intake.waitForReplaySegment({ timeout: 20_000 });

    // The segment metadata should be populated with main-process context
    expect(segment.metadata['session']).toBeDefined();
    expect(segment.metadata['application']).toBeDefined();
    expect(segment.metadata['view']).toBeDefined();
    expect(segment.metadata['records_count']).toBeGreaterThan(0);
    expect(segment.metadata['source']).toBe('browser');
  });

  test('view event includes has_replay: true after a replay segment is sent', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    // Open bridge window and wait for recording to produce data
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);
    expect(await bridgeWindow.getBridgeCapabilities()).toContain('records');
    await bridgeWindow.page.waitForTimeout(2000);

    // First flush — sends the replay segment to the intake
    await mainPage.flushTransport();
    await intake.waitForReplaySegment({ timeout: 20_000 });

    // Trigger renderer activity so browser-rum emits a fresh view update.
    // generateError works in file:// context (unlike fetch-based generateResource).
    // Assembly will enrich the resulting view update with has_replay: true now
    // that replay stats exist for this view.
    await bridgeWindow.generateError('replay-trigger');
    await mainPage.flushTransport();

    const viewEvents = await intake.waitForEventCount('view', 1, {
      timeout: 20_000,
      predicate: (e) => {
        const body = e.body as Record<string, unknown>;
        const session = body['session'] as Record<string, unknown> | undefined;
        return session?.['has_replay'] === true;
      },
    });

    expect(viewEvents.length).toBeGreaterThanOrEqual(1);
  });
});

test.describe('session replay privacy masking', () => {
  test.describe('with defaultPrivacyLevel: mask', () => {
    test.use({ sdkConfigOverrides: { defaultPrivacyLevel: 'mask' } });

    test('masks text nodes in the recorded segment', async ({ electronApp, mainPage, intake }) => {
      const recordsJson = await recordSensitiveTextAndFlush(electronApp, mainPage, intake);
      expect(recordsJson).not.toContain(SENSITIVE_TEXT);
    });
  });

  test.describe('with defaultPrivacyLevel: allow', () => {
    test.use({ sdkConfigOverrides: { defaultPrivacyLevel: 'allow' } });

    test('keeps text nodes verbatim in the recorded segment', async ({ electronApp, mainPage, intake }) => {
      const recordsJson = await recordSensitiveTextAndFlush(electronApp, mainPage, intake);
      expect(recordsJson).toContain(SENSITIVE_TEXT);
    });
  });
});
