declare global {
  interface Window {
    electronAPI: Record<string, never>;
  }
}

export {};
