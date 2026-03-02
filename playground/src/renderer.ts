// Type definition for the exposed API
interface ElectronAPI {
  getSessionFile: () => Promise<string | null>;
  stopSession: () => Promise<void>;
  generateActivity: () => Promise<void>;
  generateTelemetryError: () => Promise<void>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// This export makes this file a module, which is needed for global augmentation
export {};

const sessionContent = document.getElementById('session-content') as HTMLPreElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;

const DISK_SETTLE_DELAY = 100;
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function refreshSessionDisplay() {
  await delay(DISK_SETTLE_DELAY);
  try {
    const content = await window.electronAPI.getSessionFile();
    if (content) {
      // Try to pretty-print JSON
      try {
        const parsed = JSON.parse(content);
        sessionContent.textContent = JSON.stringify(parsed, null, 2);
      } catch {
        // Not valid JSON, display as-is
        sessionContent.textContent = content;
      }
      sessionContent.style.opacity = '1';
    } else {
      sessionContent.textContent = 'No session file found';
      sessionContent.style.opacity = '0.6';
    }
  } catch (error) {
    console.error('Error fetching session file:', error);
    sessionContent.textContent = `Error: ${String(error)}`;
    sessionContent.style.opacity = '0.6';
  }
}

if (stopBtn && sessionContent) {
  // Load session file content on page load
  void refreshSessionDisplay();

  // Handle stop session button click
  stopBtn.addEventListener('click', () => {
    void (async () => {
      try {
        stopBtn.disabled = true;
        stopBtn.textContent = 'Stopping...';

        await window.electronAPI.stopSession();
        await refreshSessionDisplay();

        stopBtn.textContent = 'Stop Session';
        stopBtn.disabled = false;
      } catch (error) {
        console.error('Error stopping session:', error);
        stopBtn.textContent = 'Stop Session';
        stopBtn.disabled = false;
      }
    })();
  });
} else {
  console.error('Required elements not found');
}

// Handle generate activity button click
const activityButton = document.getElementById('generate-activity') as HTMLButtonElement;
activityButton.addEventListener('click', () => {
  void window.electronAPI.generateActivity().then(() => refreshSessionDisplay());
});

// Handle telemetry error button click
const telemetryErrorButton = document.getElementById('generate-telemetry-error') as HTMLButtonElement;
telemetryErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateTelemetryError().then(() => refreshSessionDisplay());
});
