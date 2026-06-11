'use strict';

const fs = require('fs');
const path = require('path');

const PRELOAD_REL = 'packages/datadog-instrumentations/src/electron/preload.js';

// The replacement preload — identical to upstream except getCapabilities()
// returns '["records"]' to enable session replay recording.
const NEW_PRELOAD = `'use strict';

// eslint-disable-next-line n/no-missing-require
const { contextBridge, ipcRenderer } = require('electron');

const BRIDGE_CHANNEL = 'datadog:bridge-send';
const CONFIG_CHANNEL = 'datadog:bridge-config';

// Privacy levels matching @datadog/browser-core DefaultPrivacyLevel
const MASK = 'mask';

const config = ipcRenderer.sendSync(CONFIG_CHANNEL);

const defaultPrivacyLevel = config?.defaultPrivacyLevel ?? MASK;
const configuredHosts = config?.allowedWebViewHosts ?? [];
// eslint-disable-next-line no-undef
const allowedHosts = [...new Set([location.hostname, ...configuredHosts])];

const bridge = {
  getCapabilities() {
    return '["records"]';
  },
  getPrivacyLevel() {
    return defaultPrivacyLevel;
  },
  getAllowedWebViewHosts() {
    return JSON.stringify(allowedHosts);
  },
  send(msg) {
    ipcRenderer.send(BRIDGE_CHANNEL, msg);
  },
};

// Support both contextIsolation enabled (default) and disabled

window.DatadogEventBridge = bridge;

try {
  contextBridge.exposeInMainWorld('DatadogEventBridge', bridge);
} catch {
  // exposeInMainWorld throws when contextIsolation is disabled
}
`;

function findPreloadIn(dir) {
  const p = path.join(dir, 'node_modules', 'dd-trace', PRELOAD_REL);
  return fs.existsSync(p) ? p : null;
}

/** Walk up from dir looking for a package.json with a workspaces field. */
function findMonorepoRoot(dir) {
  let current = dir;
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) return null;
    const pkgPath = path.join(parent, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.workspaces) return parent;
      } catch {}
    }
    current = parent;
  }
}

const cwd = process.cwd();

let preloadPath = findPreloadIn(cwd);

if (!preloadPath) {
  const root = findMonorepoRoot(cwd);
  if (root) preloadPath = findPreloadIn(root);
}

if (!preloadPath) {
  console.log('[datadog] dd-trace preload.js not found — skipping patch');
  process.exit(0);
}

try {
  fs.writeFileSync(preloadPath, NEW_PRELOAD, 'utf8');
  console.log('[datadog] Patched', path.relative(cwd, preloadPath));
} catch (err) {
  console.warn('[datadog] Could not patch dd-trace preload:', err.message);
}
