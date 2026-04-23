/**
 * Utility process SDK module.
 *
 * Imported by the customer at the top of their utility process entry file:
 *   require('@datadog/electron-sdk/utility')
 *
 * Registers error listeners and forwards uncaught exceptions/rejections
 * to the main process via process.parentPort.postMessage().
 *
 * This module does NOT register any parentPort.on('message') listener.
 * Electron buffers parentPort messages until the first listener is registered,
 * so adding a listener here would drain the buffer before the customer's
 * handlers are set up — breaking apps like VS Code that expect to receive
 * their first message in their own handler.
 *
 * Instead, errors are sent as { __dd: true, type: 'error', ... } messages
 * via parentPort.postMessage(). The main process intercepts these at the
 * child.emit('message') level, swallowing them before customer handlers see them.
 */

export function setupUtilityPreload(): void {
  if (!process.parentPort) return;

  const parentPort = process.parentPort;

  function sendError(error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    parentPort.postMessage({
      __dd: true,
      type: 'error',
      message: err.message,
      stack: err.stack,
    });
  }

  process.on('uncaughtException', (error: Error) => {
    sendError(error);
    process.removeAllListeners('uncaughtException');
    throw error;
  });

  process.on('unhandledRejection', (reason: unknown) => {
    sendError(reason);
  });
}
