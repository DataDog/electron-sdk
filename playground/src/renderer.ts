// Type definition for the exposed API
interface ElectronAPI {
  getSessionFile: () => Promise<string | null>;
  clearSessionFile: () => Promise<void>;
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
const clearBtn = document.getElementById('clear-btn') as HTMLButtonElement;

async function refreshSessionDisplay() {
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

if (clearBtn && sessionContent) {
  // Load session file content on page load
  void refreshSessionDisplay();

  // Handle clear button click
  clearBtn.addEventListener('click', () => {
    void (async () => {
      try {
        clearBtn.disabled = true;
        clearBtn.textContent = 'Clearing...';

        await window.electronAPI.clearSessionFile();
        await refreshSessionDisplay();

        clearBtn.textContent = 'Clear Session';
        clearBtn.disabled = false;
      } catch (error) {
        console.error('Error clearing session:', error);
        clearBtn.textContent = 'Clear Session';
        clearBtn.disabled = false;
      }
    })();
  });
} else {
  console.error('Required elements not found');
}

// Handle telemetry error button click
const telemetryErrorButton = document.getElementById('generate-telemetry-error') as HTMLButtonElement;
telemetryErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateTelemetryError();
});
