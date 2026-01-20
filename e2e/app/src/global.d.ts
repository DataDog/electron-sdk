declare global {
  interface Window {
    electronAPI: {
      initSDK: () => Promise<{ success: boolean; result?: boolean; error?: string }>;
    };
  }
}

export {};
