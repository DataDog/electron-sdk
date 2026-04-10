import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, session } from 'electron';
import { displayInfo } from '../tools/display';
import { monitor } from '../domain/telemetry';

const PRELOAD_FILENAME = 'preload-auto.cjs';

export function registerPreload(): void {
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const preloadPath = path.join(currentDir, PRELOAD_FILENAME);

  if (!fs.existsSync(preloadPath)) {
    displayInfo(
      `Auto-injection of ${PRELOAD_FILENAME} skipped (file not found). If you're using a bundler, this is expected when using the manual preload import.`
    );
    return;
  }
  void app.whenReady().then(
    monitor(() => {
      // Session can only be accessed when app is ready
      session.defaultSession.registerPreloadScript({
        type: 'frame',
        filePath: preloadPath,
      });
    })
  );
}
