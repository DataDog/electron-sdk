/**
 * worker_threads e2e child: gets its private flags port from workerData. In `once` mode it
 * evaluates, reports and keeps no other handle, so it must exit naturally.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { connectFlags, type FlagsPortLike } from '@datadog/electron-sdk/child';

const { flagsPort, mode } = workerData as { flagsPort: FlagsPortLike; mode: 'serve' | 'once' };
const flags = connectFlags(flagsPort);

const evaluate = async () => {
  const ready = await flags.whenReady({ timeout: 5000 });
  const details = flags.getStringDetails('targeted-flag', 'default');
  return { ready, value: details.value, variant: details.variant, status: flags.status };
};

if (mode === 'once') {
  void evaluate().then((result) => parentPort?.postMessage({ id: 0, result }));
} else {
  parentPort?.on('message', (message: { id: number }) => {
    void evaluate().then((result) => parentPort?.postMessage({ id: message.id, result }));
  });
}
