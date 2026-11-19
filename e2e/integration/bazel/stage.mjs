import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';

const [input, output, mode] = process.argv.slice(2);
await stage(input, join(output, 'dist'));
if (mode === 'default-copy') await stage('node_modules', join(output, 'node_modules'));
await fs.writeFile(
  join(output, 'package.json'),
  JSON.stringify({ name: 'bazel-electron-sdk', version: '1.0.0', main: 'dist/main.js' })
);

// Materialize Bazel's input-file symlinks, retaining the relative directory links that
// connect rules_js's versioned package stores. Flattening those stores loses dependency versions.
async function stage(source, destination) {
  if ((await fs.stat(source)).isDirectory()) {
    const link = (await fs.lstat(source)).isSymbolicLink() ? await fs.readlink(source) : undefined;
    if (link && !isAbsolute(link)) {
      await fs.mkdir(dirname(destination), { recursive: true });
      await fs.symlink(link, destination);
      return;
    }
    await fs.mkdir(destination, { recursive: true });
    for (const name of await fs.readdir(source)) await stage(join(source, name), join(destination, name));
  } else {
    await fs.mkdir(dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
  }
}
