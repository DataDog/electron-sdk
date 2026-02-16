declare global {
  interface Window {
    electronAPI: {
      generateTelemetryError: () => Promise<void>;
    };
  }
}

export {};
