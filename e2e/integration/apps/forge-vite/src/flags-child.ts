/**
 * Integration fixture: a forked ELECTRON_RUN_AS_NODE child that evaluates feature flags with
 * `@datadog/electron-sdk/child`. Flags frames ride the app's own process.send protocol.
 */
import { connectFlags } from '@datadog/electron-sdk/child';

interface ChildMessage {
  type?: string;
  frame?: unknown;
  id?: number;
  flagKey?: string;
  defaultValue?: string;
}

const flags = connectFlags({ send: (frame) => process.send?.({ type: 'dd-flags', frame }) });

process.on('message', (message: ChildMessage) => {
  if (message.type === 'dd-flags') {
    flags.receive(message.frame);
  } else if (message.type === 'evaluate') {
    void flags.whenReady({ timeout: 5000 }).then(() => {
      const details = flags.getStringDetails(message.flagKey ?? '', message.defaultValue ?? '');
      process.send?.({
        type: 'evaluation',
        id: message.id,
        value: details.value,
        variant: details.variant,
        status: flags.status,
      });
    });
  }
});
