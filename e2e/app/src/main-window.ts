import { datadogRum } from '@datadog/browser-rum';

const rumBrowserSdkConfig = window.e2eConfig?.rumBrowserSdk;
if (rumBrowserSdkConfig) {
  datadogRum.init(rumBrowserSdkConfig);
}

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
