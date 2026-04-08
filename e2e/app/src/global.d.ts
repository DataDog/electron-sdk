import type { RumInitConfiguration } from '@datadog/browser-rum';

declare global {
  interface Window {
    e2eConfig?: {
      rumBrowserSdk: RumInitConfiguration;
    };
    electronAPI: {
      generateTelemetryErrors: (count: number) => Promise<void>;
      stopSession: () => Promise<void>;
      generateUncaughtException: () => Promise<void>;
      generateUnhandledRejection: () => Promise<void>;
      generateManualError: (startTime?: number) => Promise<void>;
      crash: () => Promise<void>;
      openBridgeFileWindow: () => Promise<void>;
      openBridgeFileWindowNoIsolation: () => Promise<void>;
      openBridgeHttpWindow: () => Promise<void>;
    };
  }
}

export {};
