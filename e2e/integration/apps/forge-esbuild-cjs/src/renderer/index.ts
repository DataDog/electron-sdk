import { datadogRum } from '@datadog/browser-rum';
import { ElectronRendererFlagsProvider } from '@datadog/electron-sdk/renderer';
import { OpenFeature } from '@openfeature/web-sdk';

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

// Feature flags: the renderer provider finds the DatadogFlagsBridge exposed by the SDK preload.
const flagsReady = OpenFeature.setProviderAndWait(new ElectronRendererFlagsProvider()).catch(() => undefined);

// Expose test helpers on window so Playwright tests can trigger events via page.evaluate()
(
  window as Window &
    typeof globalThis & {
      __integrationTest: {
        triggerRendererError: (message: string) => void;
        evaluateFlag: (
          flagKey: string,
          defaultValue: string
        ) => Promise<{ value: string; variant?: string; errorCode?: string }>;
      };
    }
).__integrationTest = {
  triggerRendererError: (message: string) => {
    datadogRum.addError(new Error(message));
  },
  evaluateFlag: async (flagKey: string, defaultValue: string) => {
    await flagsReady;
    const details = OpenFeature.getClient().getStringDetails(flagKey, defaultValue);
    return { value: details.value, variant: details.variant, errorCode: details.errorCode };
  },
};
