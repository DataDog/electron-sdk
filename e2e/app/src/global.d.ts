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
      openRendererFileWindow: () => Promise<void>;
      openRendererFileWindowNoIsolation: () => Promise<void>;
      openRendererHttpWindow: () => Promise<void>;
    };
  }
}

export {};
