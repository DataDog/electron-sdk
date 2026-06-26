import type { ElectronApplication, Page } from '@playwright/test';
import type { AccountInfo, FailureReason, FeatureOperationOptions, UserInfo } from '@datadog/electron-sdk';
import { BridgeWindowPage } from './bridgeWindowPage';

// declare exposed IPC methods called directly in tests
interface ElectronAppWindow {
  electronAPI: {
    generateTelemetryErrors: (count: number) => Promise<void>;
    generateManualError: (startTime?: number) => Promise<void>;
    startOperation: (name: string, options?: FeatureOperationOptions) => Promise<void>;
    succeedOperation: (name: string, options?: FeatureOperationOptions) => Promise<void>;
    failOperation: (name: string, failureReason: FailureReason, options?: FeatureOperationOptions) => Promise<void>;
    mainFetch: (url: string) => Promise<number>;
    mainHttpRequest: (url: string) => Promise<number>;
    mainNetRequest: (url: string) => Promise<number>;
    flushTransport: () => Promise<void>;
    setUserInfo: (user: UserInfo) => Promise<void>;
    clearUserInfo: () => Promise<void>;
    addUserExtraInfo: (extraInfo: Record<string, unknown>) => Promise<void>;
    setAccountInfo: (accountInfo: AccountInfo) => Promise<void>;
    clearAccountInfo: () => Promise<void>;
    addAccountExtraInfo: (extraInfo: Record<string, unknown>) => Promise<void>;
    ping: () => Promise<string>;
    stopSession: () => Promise<void>;
    openBridgeFileWindow: () => Promise<void>;
    openBridgeFileWindowNoIsolation: () => Promise<void>;
    openBridgeHttpWindow: () => Promise<void>;
  };
}

/**
 * Page Object to interact with the main app window
 */
export class MainPage {
  constructor(private readonly page: Page) {}

  async renewSession() {
    await this.stopSession();
    await this.generateActivity();
  }

  async stopSession() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.stopSession());
  }

  async generateActivity() {
    await this.page.locator('#generate-activity').click();
    await this.waitForIpcPropagation();
  }

  private async waitForIpcPropagation() {
    // Wait for event propagation: renderer → bridge IPC -> main → transport
    await this.page.waitForTimeout(1000);
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
    await this.page.evaluate(
      (ts) => (globalThis as unknown as ElectronAppWindow).electronAPI.generateManualError(ts),
      startTime
    );
  }

  async startOperation(name: string, options?: FeatureOperationOptions) {
    await this.page.evaluate(
      ({ name, options }) => (globalThis as unknown as ElectronAppWindow).electronAPI.startOperation(name, options),
      { name, options }
    );
  }

  async succeedOperation(name: string, options?: FeatureOperationOptions) {
    await this.page.evaluate(
      ({ name, options }) => (globalThis as unknown as ElectronAppWindow).electronAPI.succeedOperation(name, options),
      { name, options }
    );
  }

  async failOperation(name: string, failureReason: FailureReason, options?: FeatureOperationOptions) {
    await this.page.evaluate(
      ({ name, failureReason, options }) =>
        (globalThis as unknown as ElectronAppWindow).electronAPI.failOperation(name, failureReason, options),
      { name, failureReason, options }
    );
  }

  async mainFetch(url: string): Promise<number> {
    return await this.page.evaluate((u) => (globalThis as unknown as ElectronAppWindow).electronAPI.mainFetch(u), url);
  }

  async mainHttpRequest(url: string): Promise<number> {
    return await this.page.evaluate(
      (u) => (globalThis as unknown as ElectronAppWindow).electronAPI.mainHttpRequest(u),
      url
    );
  }

  async mainNetRequest(url: string): Promise<number> {
    return await this.page.evaluate(
      (u) => (globalThis as unknown as ElectronAppWindow).electronAPI.mainNetRequest(u),
      url
    );
  }

  async mainPing(): Promise<string> {
    return await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.ping());
  }

  async flushTransport() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.flushTransport());
  }

  async setUserInfo(user: UserInfo) {
    await this.page.evaluate((u) => (globalThis as unknown as ElectronAppWindow).electronAPI.setUserInfo(u), user);
  }

  async clearUserInfo() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.clearUserInfo());
  }

  async addUserExtraInfo(extraInfo: Record<string, unknown>) {
    await this.page.evaluate(
      (info) => (globalThis as unknown as ElectronAppWindow).electronAPI.addUserExtraInfo(info),
      extraInfo
    );
  }

  async setAccountInfo(accountInfo: AccountInfo) {
    await this.page.evaluate(
      (a) => (globalThis as unknown as ElectronAppWindow).electronAPI.setAccountInfo(a),
      accountInfo
    );
  }

  async clearAccountInfo() {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.clearAccountInfo());
  }

  async addAccountExtraInfo(extraInfo: Record<string, unknown>) {
    await this.page.evaluate(
      (info) => (globalThis as unknown as ElectronAppWindow).electronAPI.addAccountExtraInfo(info),
      extraInfo
    );
  }

  crash() {
    void this.page
      .locator('#crash')
      .click()
      .catch(() => {
        // app will crash
      });
  }

  async openBridgeFileWindow(electronApp: ElectronApplication) {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.openBridgeFileWindow());
    return await BridgeWindowPage.waitForReady(electronApp);
  }

  async openBridgeFileWindowNoIsolation(electronApp: ElectronApplication) {
    await this.page.evaluate(() =>
      (globalThis as unknown as ElectronAppWindow).electronAPI.openBridgeFileWindowNoIsolation()
    );
    return await BridgeWindowPage.waitForReady(electronApp);
  }

  async openBridgeHttpWindow(electronApp: ElectronApplication) {
    await this.page.evaluate(() => (globalThis as unknown as ElectronAppWindow).electronAPI.openBridgeHttpWindow());
    return await BridgeWindowPage.waitForReady(electronApp);
  }
}
