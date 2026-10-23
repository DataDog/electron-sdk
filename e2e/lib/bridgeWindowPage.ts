import type { Page, ElectronApplication } from '@playwright/test';

/**
 * Page Object for bridge windows (bridge-window.html).
 * Use static factory methods to open a window and wait for it to be bridge-ready.
 */
export class BridgeWindowPage {
  constructor(readonly page: Page) {}

  static async waitForReady(electronApp: ElectronApplication): Promise<BridgeWindowPage> {
    const page = await electronApp.waitForEvent('window');
    await page.waitForSelector('#status');
    await page.waitForFunction('document.getElementById("status")?.textContent === "bridge-ready"');
    return new BridgeWindowPage(page);
  }

  async generateError(message: string) {
    await this.page.evaluate((msg) => {
      setTimeout(() => {
        throw new Error(msg);
      }, 0);
    }, message);
    await this.waitForIpcPropagation();
  }

  async generateResource() {
    await this.page.evaluate(() => fetch('/'));
    await this.waitForIpcPropagation();
  }

  async generateLongTask(durationMs = 500): Promise<void> {
    await this.page.evaluate(
      (duration) =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            const start = Date.now();
            while (Date.now() - start < duration) {
              /* block to generate a long task */
            }
            resolve();
          }, 0);
        }),
      durationMs
    );
  }

  /**
   * Calls a browser SDK API that reports usage telemetry, which reaches the main process as an
   * `internal_telemetry` bridge event. Unlike the configuration event the browser SDK sends at init,
   * this one is emitted once its view exists, so it carries the renderer's view id.
   */
  async generateTelemetryUsage(): Promise<void> {
    await this.page.evaluate(() => {
      (globalThis as unknown as { DD_RUM: { addAction(name: string): void } }).DD_RUM.addAction('renderer-usage');
    });
    await this.waitForIpcPropagation();
  }

  /**
   * Emits a log through the renderer's browser Logs SDK, which reaches the main process as a `log`
   * bridge event. In bridge mode the Logs SDK cannot reach intake at all, so this is the only path.
   */
  async generateLog(message: string, context?: Record<string, unknown>): Promise<void> {
    await this.page.evaluate(
      ([msg, ctx]) => {
        (
          globalThis as unknown as {
            DD_LOGS: { logger: { info(message: string, context?: Record<string, unknown>): void } };
          }
        ).DD_LOGS.logger.info(msg, ctx);
      },
      [message, context] as const
    );
    await this.waitForIpcPropagation();
  }

  /**
   * Emits `count` logs in a single round trip, then waits once. A loop over {@link generateLog} would
   * pay the IPC propagation wait per log and blow the test timeout.
   */
  async generateLogs(count: number, prefix: string): Promise<void> {
    await this.page.evaluate(
      ([total, messagePrefix]) => {
        const logs = (globalThis as unknown as { DD_LOGS: { logger: { info(message: string): void } } }).DD_LOGS;
        for (let i = 0; i < total; i++) {
          logs.logger.info(`${messagePrefix}${i}`);
        }
      },
      [count, prefix] as const
    );
    await this.waitForIpcPropagation();
  }

  async getBridgeCapabilities(): Promise<string[]> {
    return this.page.evaluate(() => {
      const bridge = (
        globalThis as unknown as {
          DatadogEventBridge: { getCapabilities(): string };
        }
      ).DatadogEventBridge;

      return JSON.parse(bridge.getCapabilities()) as string[];
    });
  }

  async triggerProfilingFlush(): Promise<void> {
    await this.page.close({ runBeforeUnload: true });
    // Wait for IPC propagation: beforeunload → bridge send → main process → write queue
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  private async waitForIpcPropagation() {
    // Wait for event propagation: renderer → bridge IPC -> main → transport
    await this.page.waitForTimeout(1000);
  }
}
