/**
 * Forked e2e child (ELECTRON_RUN_AS_NODE): an app with its own correlated protocol on
 * process.send ({ id, method, params } -> { id, result }) that routes `dd-flags` frames to
 * the SDK. It counts every message its own handler receives, and flags any SDK envelope that
 * reaches it (there must be none).
 */
import { connectFlags } from '@datadog/electron-sdk/child';

interface AppRequest {
  id?: unknown;
  method?: unknown;
  params?: Record<string, unknown>;
  type?: unknown;
  frame?: unknown;
  __ddElectronSdkFlags?: unknown;
}

let appMessages = 0;
let sdkEnvelopesSeen = 0;

const flags =
  process.env.DD_E2E_FLAGS_CHILD_ENDPOINT === 'none'
    ? Object.assign(connectFlags(undefined), { receive: (_frame: unknown) => undefined })
    : connectFlags({ send: (frame) => process.send?.({ type: 'dd-flags', frame }) });

process.on('message', (message: AppRequest) => {
  if (message.type === 'dd-flags') {
    flags.receive(message.frame);
    return;
  }
  appMessages += 1;
  if (message.__ddElectronSdkFlags !== undefined) {
    sdkEnvelopesSeen += 1;
  }
  if (typeof message.id === 'number' && typeof message.method === 'string') {
    void handle(message.method, message.params ?? {}).then((result) => process.send?.({ id: message.id, result }));
  }
});

async function handle(method: string, params: Record<string, unknown>): Promise<unknown> {
  switch (method) {
    case 'ping':
      return { n: params.n, appMessages, sdkEnvelopesSeen };
    case 'evaluate': {
      const details = flags.getStringDetails(String(params.flagKey), String(params.defaultValue));
      return { value: details.value, variant: details.variant, errorCode: details.errorCode, status: flags.status };
    }
    case 'status':
      return { status: flags.status, appMessages, sdkEnvelopesSeen };
    case 'whenReady':
      return flags.whenReady({ timeout: Number(params.timeout ?? 5000) });
    case 'requestContext':
      return flags.requestContextUpdate(params.context as Record<string, unknown>);
    default:
      return { error: `unknown method ${method}` };
  }
}
