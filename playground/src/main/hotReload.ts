import { app } from 'electron';
import * as path from 'path';

export function setupHotReload(): void {
  // Watch playground files - delay startup to avoid initial compilation triggers
  try {
    setTimeout(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('electron-reloader')(module, {
        debug: true,
        watchRenderer: true,
        ignore: [/node_modules/, /\.\.\/dist/], // Don't watch parent SDK dist
      });
    }, 3000);
  } catch (err) {
    console.log('Error loading electron-reloader:', err);
  }

  // Watch parent SDK's dist folder for changes
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const chokidar = require('chokidar') as typeof import('chokidar');
    const sdkDistPath = path.join(__dirname, '../../dist');

    console.log('Watching parent SDK dist folder:', sdkDistPath);

    let reloadTimeout: NodeJS.Timeout | null = null;
    let isReady = false;

    // Grace period to avoid triggering on initial build activity
    setTimeout(() => {
      isReady = true;
      console.log('SDK watcher is now active');
    }, 5000);

    const watcher = chokidar.watch(sdkDistPath, {
      ignored: /(^|[\\/])\../,
      persistent: true,
      ignoreInitial: true, // Don't trigger on initial file scan
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 100,
      },
    });

    watcher.on('change', (changedPath: string) => {
      // Ignore changes during startup grace period
      if (!isReady) {
        console.log('SDK file changed (ignored - startup grace period):', changedPath);
        return;
      }

      console.log('SDK file changed:', changedPath);

      // Debounce reloads to prevent multiple rapid restarts
      if (reloadTimeout) {
        clearTimeout(reloadTimeout);
      }

      reloadTimeout = setTimeout(() => {
        // Clear require cache for SDK modules
        Object.keys(require.cache).forEach((key) => {
          if (key.includes('@datadog/electron-sdk')) {
            console.log('Clearing cache for:', key);
            delete require.cache[key];
          }
        });

        console.log('Reloading app...');
        app.relaunch();
        app.exit(0);
      }, 200);
    });
  } catch (err) {
    console.log('Error setting up SDK watcher:', err);
  }
}
