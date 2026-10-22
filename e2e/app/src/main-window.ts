import { datadogRum } from '@datadog/browser-rum';
import { ElectronRendererFlagsProvider } from '@datadog/electron-sdk/renderer';
import { OpenFeature } from '@openfeature/web-sdk';

const rumBrowserSdkConfig = window.e2eConfig?.rumBrowserSdk;
if (rumBrowserSdkConfig) {
  datadogRum.init(rumBrowserSdkConfig);
}

// Feature flags: the renderer provider finds the DatadogFlagsBridge exposed by the SDK preload.
const flagsReady = OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider()).catch(() => undefined);

// Expose renderer flag evaluation for e2e tests
(window as unknown as Record<string, unknown>).__rendererEvaluateFlag = async (
  type: 'boolean' | 'string',
  flagKey: string,
  defaultValue: unknown
) => {
  await flagsReady;
  const client = OpenFeature.getClient();
  if (type === 'boolean') {
    const d = client.getBooleanDetails(flagKey, defaultValue as boolean);
    return { value: d.value, variant: d.variant, reason: d.reason, errorCode: d.errorCode };
  }
  const d = client.getStringDetails(flagKey, defaultValue as string);
  return { value: d.value, variant: d.variant, reason: d.reason, errorCode: d.errorCode };
};

(window as unknown as Record<string, unknown>).__rendererFlagStatus = () => OpenFeature.getClient().providerStatus;
(window as unknown as Record<string, unknown>).__hasFlagsBridge = () =>
  (window as unknown as { DatadogFlagsBridge?: unknown }).DatadogFlagsBridge !== undefined;

const statusDiv = document.getElementById('status') as HTMLDivElement;
statusDiv.textContent = 'SDK initialized in main process';
statusDiv.className = 'info';

const telemetryErrorButton = document.getElementById('generate-telemetry-error') as HTMLButtonElement;
telemetryErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateTelemetryErrors(1).then(() => {
    statusDiv.textContent = 'Telemetry error generated';
  });
});

const stopSessionButton = document.getElementById('stop-session') as HTMLButtonElement;
stopSessionButton.addEventListener('click', () => {
  void window.electronAPI.stopSession().then(() => {
    statusDiv.textContent = 'Session stopped';
  });
});

const uncaughtExceptionButton = document.getElementById('generate-uncaught-exception') as HTMLButtonElement;
uncaughtExceptionButton.addEventListener('click', () => {
  void window.electronAPI.generateUncaughtException().then(() => {
    statusDiv.textContent = 'Uncaught exception generated';
  });
});

const unhandledRejectionButton = document.getElementById('generate-unhandled-rejection') as HTMLButtonElement;
unhandledRejectionButton.addEventListener('click', () => {
  void window.electronAPI.generateUnhandledRejection().then(() => {
    statusDiv.textContent = 'Unhandled rejection generated';
  });
});

const crashButton = document.getElementById('crash') as HTMLButtonElement;
crashButton.addEventListener('click', () => {
  void window.electronAPI.crash();
});

const manualErrorButton = document.getElementById('generate-manual-error') as HTMLButtonElement;
manualErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateManualError().then(() => {
    statusDiv.textContent = 'Manual error generated';
  });
});
