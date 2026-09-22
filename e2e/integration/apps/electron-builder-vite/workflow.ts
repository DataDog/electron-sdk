export function getWorkflow(mode: string): 'default-copy' | 'plugin-copy' {
  if (mode === 'default-copy' || mode === 'plugin-copy') return mode;
  throw new Error(`Expected Vite mode "default-copy" or "plugin-copy", received "${mode}"`);
}
