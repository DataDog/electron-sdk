/** Prepares static E2E renderer assets in a shell-independent way. */
import fs from 'node:fs';
import path from 'node:path';

const appRoot = path.join(import.meta.dirname, '..');
const outputDirectory = path.join(appRoot, 'dist');

fs.mkdirSync(outputDirectory, { recursive: true });
for (const asset of ['bridge-window.html', 'main-window.html']) {
  fs.copyFileSync(path.join(appRoot, 'src', asset), path.join(outputDirectory, asset));
}
