const statusDiv = document.getElementById('status') as HTMLDivElement;
statusDiv.textContent = 'SDK initialized in main process';
statusDiv.className = 'info';

const telemetryErrorButton = document.getElementById('generate-telemetry-error') as HTMLButtonElement;
telemetryErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateTelemetryError().then(() => {
    statusDiv.textContent = 'Telemetry error generated';
  });
});
