import { datadogRum } from '@datadog/browser-rum';

// Initialize the browser RUM SDK in the renderer process.
// It auto-detects the DatadogEventBridge exposed by the electron-sdk preload
// and sends all collected events (fetch, XHR, DOM, errors, views) through it
// to the main process instead of directly to the Datadog intake.
datadogRum.init({
  applicationId: '6efd3722-af0a-4070-994c-0e87076d4814',
  clientToken: 'pub2a7307cdec74934cacb411a193f632f8',
  site: 'datad0g.com',
  service: 'electron-playground',
  env: 'dev',
  sessionSampleRate: 100,
  trackResources: true,
  trackLongTasks: true,
  trackUserInteractions: true,
});

// Type definition for the exposed API
interface ElectronAPI {
  getSessionFile: () => Promise<string | null>;
  stopSession: () => Promise<void>;
  generateTelemetryError: () => Promise<void>;
  generateUncaughtException: () => Promise<void>;
  generateUnhandledRejection: () => Promise<void>;
  crash: () => Promise<void>;
  mainFetchApi: () => Promise<unknown>;
  startOperation: (name: string, options?: { operationKey?: string }) => Promise<void>;
  succeedOperation: (name: string, options?: { operationKey?: string }) => Promise<void>;
  failOperation: (
    name: string,
    failureReason: 'error' | 'abandoned' | 'other',
    options?: { operationKey?: string }
  ) => Promise<void>;
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

document.addEventListener('click', () => setTimeout(() => void refreshSessionDisplay(), 500));

// Handle telemetry error button click
const telemetryErrorButton = document.getElementById('generate-telemetry-error') as HTMLButtonElement;
telemetryErrorButton.addEventListener('click', () => {
  void window.electronAPI.generateTelemetryError();
});

// Handle uncaught exception button click
const uncaughtExceptionButton = document.getElementById('generate-uncaught-exception') as HTMLButtonElement;
uncaughtExceptionButton.addEventListener('click', () => {
  void window.electronAPI.generateUncaughtException();
});

// Handle unhandled rejection button click
const unhandledRejectionButton = document.getElementById('generate-unhandled-rejection') as HTMLButtonElement;
unhandledRejectionButton.addEventListener('click', () => {
  void window.electronAPI.generateUnhandledRejection();
});

// Handle crash button click
const crashBtn = document.getElementById('crash-btn') as HTMLButtonElement;
crashBtn.addEventListener('click', () => {
  void window.electronAPI.crash();
});
// --- IPC Activity Log ---

const ipcLog = document.getElementById('ipc-log') as HTMLDivElement;

function logIpcCall(channel: string, status: 'pending' | 'done' | 'error', duration?: number, detail?: string) {
  const entry = document.createElement('div');
  entry.className = `log-entry log-${status}`;

  const time = new Date().toLocaleTimeString('en-US', { hour12: false });
  const durationText = duration !== undefined ? ` ${duration}ms` : '';
  const preview = detail ? ` ${detail.slice(0, 100)}` : '';

  entry.innerHTML =
    `<span class="log-time">${time}</span> ` +
    `<span class="log-channel">${channel}</span>` +
    `<span class="log-duration">${durationText}</span>` +
    `<span class="log-preview">${preview}</span>`;

  ipcLog.prepend(entry);

  // Keep last 50 entries
  while (ipcLog.children.length > 50) {
    ipcLog.removeChild(ipcLog.lastChild!);
  }
}

async function trackedInvoke<T>(channel: string, fn: () => Promise<T>): Promise<T> {
  logIpcCall(channel, 'pending');
  const start = performance.now();
  try {
    const result = await fn();
    const duration = Math.round(performance.now() - start);
    logIpcCall(channel, 'done', duration, JSON.stringify(result));
    return result;
  } catch (error) {
    const duration = Math.round(performance.now() - start);
    logIpcCall(channel, 'error', duration, String(error));
    throw error;
  }
}

// --- IPC Demo Buttons ---

function setupDemoButton(id: string, channel: string, fn: () => Promise<unknown>) {
  const btn = document.getElementById(id) as HTMLButtonElement;
  if (!btn) return;
  btn.addEventListener('click', () => {
    btn.disabled = true;
    void trackedInvoke(channel, fn).finally(() => {
      btn.disabled = false;
    });
  });
}

// Renderer-side fetch (captured by browser RUM SDK)
const rendererFetchBtn = document.getElementById('demo-renderer-fetch') as HTMLButtonElement;
if (rendererFetchBtn) {
  rendererFetchBtn.addEventListener('click', () => {
    rendererFetchBtn.disabled = true;
    fetch('https://httpbin.org/json')
      .then((res) => res.json())
      .then((data) => {
        logIpcCall('renderer:fetch', 'done', 0, JSON.stringify(data));
      })
      .catch((err) => {
        logIpcCall('renderer:fetch', 'error', 0, String(err));
      })
      .finally(() => {
        rendererFetchBtn.disabled = false;
      });
  });
}

setupDemoButton('main-fetch', 'main:fetch-api', () => window.electronAPI.mainFetchApi());

// --- Operation Monitoring demo buttons ---

setupDemoButton('op-start', 'main:start-operation(checkout)', () => window.electronAPI.startOperation('checkout'));
setupDemoButton('op-succeed', 'main:succeed-operation(checkout)', () =>
  window.electronAPI.succeedOperation('checkout')
);
setupDemoButton('op-fail', 'main:fail-operation(checkout, error)', () =>
  window.electronAPI.failOperation('checkout', 'error')
);
setupDemoButton('op-keyed-start', 'main:start-operation(upload/photo_1)', () =>
  window.electronAPI.startOperation('upload', { operationKey: 'photo_1' })
);
setupDemoButton('op-keyed-succeed', 'main:succeed-operation(upload/photo_1)', () =>
  window.electronAPI.succeedOperation('upload', { operationKey: 'photo_1' })
);

// Simulate 5 parallel file uploads with different operation_keys, then complete
// each in a random order — mirrors a real upload-batch flow where individual
// uploads finish at unpredictable times.
async function runParallelUploads(): Promise<void> {
  const FAILURE_REASONS = ['error', 'abandoned', 'other'] as const;
  const keys = Array.from({ length: 5 }, (_, i) => `photo_${i + 1}`);

  // Fire all start IPC calls in parallel so the SDK observes them as concurrent.
  await Promise.all(
    keys.map(async (key) => {
      await window.electronAPI.startOperation('upload', { operationKey: key });
      logIpcCall(`main:start-operation(upload/${key})`, 'done');
    })
  );

  // Shuffle to complete in a random order.
  const completionOrder = [...keys].sort(() => Math.random() - 0.5);

  // Each completion fires after its own random delay, in parallel.
  await Promise.all(
    completionOrder.map(async (key) => {
      // Random delay 50–500ms to simulate variable upload duration.
      await new Promise<void>((resolve) => setTimeout(resolve, 50 + Math.floor(Math.random() * 450)));

      // ~70% succeed, ~30% fail with a random failure_reason.
      if (Math.random() < 0.7) {
        await window.electronAPI.succeedOperation('upload', { operationKey: key });
        logIpcCall(`main:succeed-operation(upload/${key})`, 'done');
      } else {
        const reason = FAILURE_REASONS[Math.floor(Math.random() * FAILURE_REASONS.length)];
        await window.electronAPI.failOperation('upload', reason, { operationKey: key });
        logIpcCall(`main:fail-operation(upload/${key}, ${reason})`, 'done');
      }
    })
  );
}

const parallelBtn = document.getElementById('op-parallel-uploads') as HTMLButtonElement | null;
if (parallelBtn) {
  parallelBtn.addEventListener('click', () => {
    parallelBtn.disabled = true;
    void runParallelUploads()
      .catch((err) => logIpcCall('parallel-uploads', 'error', 0, String(err)))
      .finally(() => {
        parallelBtn.disabled = false;
      });
  });
}
