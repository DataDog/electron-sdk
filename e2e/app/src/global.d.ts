declare global {
  interface Window {
    electronAPI: {
      generateTelemetryErrors: (count: number) => Promise<void>;
      stopSession: () => Promise<void>;
      generateActivity: () => Promise<void>;
      generateUncaughtException: () => Promise<void>;
      generateUnhandledRejection: () => Promise<void>;
      generateManualError: (startTime?: number) => Promise<void>;
      crash: () => Promise<void>;
      openFileWindow: () => Promise<void>;
      openHttpWindow: () => Promise<void>;
    };
  }
}

export {};
