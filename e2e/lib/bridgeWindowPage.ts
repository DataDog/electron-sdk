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
