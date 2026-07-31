import { datadogRum } from '@datadog/browser-rum';

datadogRum.init({
  clientToken: 'integration-test-token',
  applicationId: 'integration-test-app-id',
  service: 'integration-test-renderer',
  site: 'datadoghq.com',
  trackUserInteractions: false,
  trackResources: false,
  trackLongTasks: false,
  defaultPrivacyLevel: 'mask-user-input',
});

// Expose test helpers on window so Playwright tests can trigger events via page.evaluate()
(
  window as Window &
    typeof globalThis & {
      __integrationTest: { triggerRendererError: (message: string) => void };
    }
).__integrationTest = {
  triggerRendererError: (message: string) => {
    datadogRum.addError(new Error(message));
  },
};
