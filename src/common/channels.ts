export const BRIDGE_CHANNEL = 'datadog:bridge-send';
export const CONFIG_CHANNEL = 'datadog:bridge-config';

// Feature flag channels. The `datadog:` prefix keeps them out of tracing spans
// (patchIpcMain/patchWebContents skip spans for these channels).
export const FLAGS_SNAPSHOT_CHANNEL = 'datadog:flags-snapshot';
export const FLAGS_UPDATE_CHANNEL = 'datadog:flags-update';
export const FLAGS_EVALUATIONS_CHANNEL = 'datadog:flags-evaluations';
