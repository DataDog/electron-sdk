const initBtn = document.getElementById('init-btn') as HTMLButtonElement;
const resultDiv = document.getElementById('result') as HTMLDivElement;

initBtn.addEventListener('click', () => {
  void (async () => {
    initBtn.disabled = true;
    resultDiv.textContent = 'Initializing...';
    resultDiv.className = '';

    try {
      const response = await window.electronAPI.initSDK();

      if (response.success && response.result) {
        resultDiv.textContent = 'true';
        resultDiv.className = 'success';
      } else {
        resultDiv.textContent = response.error || 'false';
        resultDiv.className = 'error';
      }
    } catch (error) {
      resultDiv.textContent = String(error);
      resultDiv.className = 'error';
    } finally {
      initBtn.disabled = false;
    }
  })();
});
