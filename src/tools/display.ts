const PREFIX = '[Datadog electron-sdk]';

/**
 * Display an error in the console with the SDK prefix
 */
export function displayError(...args: unknown[]) {
  console.error(PREFIX, ...args);
}

/**
 * Display a warning in the console with the SDK prefix
 */
export function displayWarn(...args: unknown[]) {
  console.warn(PREFIX, ...args);
}

/**
 * Display an info in the console with the SDK prefix
 */
export function displayInfo(...args: unknown[]) {
  console.info(PREFIX, ...args);
}
