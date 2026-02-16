const PREFIX = '[Datadog electron-sdk]';

/**
 * Display an error in the console with the SDK prefix
 */
export function displayError(...args: unknown[]) {
  console.error(PREFIX, ...args);
}
