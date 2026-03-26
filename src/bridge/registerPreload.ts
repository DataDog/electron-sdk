import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { session } from 'electron';

export function registerPreload(): void {
  const currentDir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
  const preloadPath = path.join(currentDir, 'preload-auto.cjs');
  session.defaultSession.registerPreloadScript({
    type: 'frame',
    filePath: preloadPath,
  });
}
