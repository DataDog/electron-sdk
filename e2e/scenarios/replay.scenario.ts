import { test, expect } from '../lib/helpers';

/**
 * Session replay E2E scenarios.
 *
 * These tests verify that:
 * 1. The dd-trace preload exposes "records" capability so the browser RUM SDK
 *    starts emitting BrowserRecord events through the bridge.
 * 2. ReplayCollection buffers those records and emits a compressed segment.
 * 3. ReplayBatchConsumer uploads the segment as multipart/form-data and the
 *    mock intake receives it with correct metadata.
 */

test.describe('session replay', () => {
  test('replay segment arrives at the intake after opening a bridge window', async ({
    electronApp,
    mainPage,
    intake,
  }) => {
    // Open a bridge window — the browser RUM SDK initialises and, because the
    // dd-trace preload advertises "records" capability, starts recording rrweb events.
    const bridgeWindow = await mainPage.openBridgeFileWindow(electronApp);

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
