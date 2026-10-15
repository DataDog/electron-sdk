/**
 * utilityProcess e2e child: gets its private flags port from the app's own `init` message,
 * then answers the app's correlated requests on process.parentPort.
 */
import { connectFlags, type ChildFlagsClient, type FlagsPortLike } from '@datadog/electron-sdk/child';

interface ParentPort {
  on(
    event: 'message',
    listener: (event: { data: { type?: string; id?: number }; ports: FlagsPortLike[] }) => void
  ): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort: ParentPort }).parentPort;
let flags: ChildFlagsClient | undefined;

parentPort.on('message', (event) => {
  if (event.data.type === 'init') {
    flags = connectFlags(event.ports[0]);
    return;
  }
  const id = event.data.id;
  void (async () => {
    const ready = (await flags?.whenReady({ timeout: 5000 })) ?? false;
    const details = flags?.getStringDetails('targeted-flag', 'default');
    parentPort.postMessage({ id, result: { ready, value: details?.value, variant: details?.variant } });
  })();
});
