// Type definition for the exposed API
interface ElectronAPI {
  initSDK: () => Promise<boolean>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

// This export makes this file a module, which is needed for global augmentation
export {};

const initBtn = document.getElementById('init-btn') as HTMLButtonElement;
const resultDiv = document.getElementById('result') as HTMLDivElement;

if (initBtn && resultDiv) {
  initBtn.addEventListener('click', () => {
    void (async () => {
      try {
        console.log('Button clicked - calling SDK init in main process...');
        initBtn.disabled = true;
        initBtn.textContent = 'Initializing...';

        const result = await window.electronAPI.initSDK();

        resultDiv.textContent = `SDK initialized in main process: ${result}`;
        resultDiv.style.background = result ? 'rgba(72, 187, 120, 0.3)' : 'rgba(245, 101, 101, 0.3)';

        initBtn.textContent = 'Initialize SDK';
        initBtn.disabled = false;

        console.log('SDK init result from main process:', result);
      } catch (error) {
        console.error('Error initializing SDK:', error);
        resultDiv.textContent = `Error: ${String(error)}`;
        resultDiv.style.background = 'rgba(245, 101, 101, 0.3)';
        initBtn.textContent = 'Initialize SDK';
        initBtn.disabled = false;
      }
    })();
  });
} else {
  console.error('Button or result div not found');
}
