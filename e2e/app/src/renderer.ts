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

const generateActivityButton = document.getElementById('generate-activity') as HTMLButtonElement;
generateActivityButton.addEventListener('click', () => {
  void window.electronAPI.generateActivity().then(() => {
    statusDiv.textContent = 'Activity generated';
  });
});
