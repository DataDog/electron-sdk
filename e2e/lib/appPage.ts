import type { Page } from '@playwright/test';

// declare exposed IPC methods called directly in tests
interface ElectronAppWindow {
  electronAPI: {
    generateTelemetryErrors: (count: number) => Promise<void>;
    generateManualError: (startTime?: number) => Promise<void>;
    flushTransport: () => Promise<void>;
    openFileWindow: () => Promise<void>;
    openHttpWindow: () => Promise<void>;
  };
}

/**
 * Page Object to interact with the electron app window
 */
export class AppPage {
  constructor(private readonly page: Page) {}

  async renewSession() {
    await this.stopSession();
    await this.generateActivity();
  }

  async stopSession() {
    await this.page.locator('#stop-session').click();
  }

  async generateActivity() {
    await this.page.locator('#generate-activity').click();
  }

  async generateTelemetryError() {
    await this.page.locator('#generate-telemetry-error').click();
  }

  async generateTelemetryErrors(count: number) {
    await this.page.evaluate(
      (n) => (globalThis as unknown as ElectronAppWindow).electronAPI.generateTelemetryErrors(n),
      count
    );
  }

  async generateUncaughtException() {
    await this.page.locator('#generate-uncaught-exception').click();
  }

  async generateUnhandledRejection() {
    await this.page.locator('#generate-unhandled-rejection').click();
  }

  async generateManualError(startTime?: number) {
    if (startTime !== undefined) {
      await this.page.evaluate(
        (ts) => (globalThis as unknown as ElectronAppWindow).electronAPI.generateManualError(ts),
        startTime
      );
    } else {
      await this.page.locator('#generate-manual-error').click();
    }
  }

  async flushTransport() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.flushTransport());
  }

  crash() {
    void this.page
      .locator('#crash')
      .click()
      .catch(() => {
        // app will crash
      });
  }

  async openFileWindow() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.openFileWindow());
  }

  async openHttpWindow() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.openHttpWindow());
  }
}
