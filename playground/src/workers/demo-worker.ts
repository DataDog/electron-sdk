/**
 * Demo utility process worker for playground testing.
 * Receives messages via parentPort and responds.
 */

// Enable Datadog SDK error forwarding for this utility process
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('@datadog/electron-sdk/utility');

process.parentPort.on('message', (e: Electron.MessageEvent) => {
  const { action } = e.data as { action: string };

  if (action === 'ping') {
    process.parentPort.postMessage({ reply: 'pong' });
  } else if (action === 'crash') {
    process.crash();
  } else if (action === 'exit-clean') {
    process.exit(0);
  } else if (action === 'exit-error') {
    process.exit(1);
  } else if (action === 'throw-error') {
    throw new Error('Uncaught error in utility process');
  }
});

// Signal that the worker is ready
process.parentPort.postMessage({ ready: true });
