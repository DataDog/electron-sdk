import { writeFile } from 'node:fs/promises';
import { build } from 'vite';

const [output, mode] = process.argv.slice(2);
for (const config of ['main', 'preload']) {
  await build({
    configFile: `vite.${config}.config.ts`,
    mode,
    build: { outDir: output, emptyOutDir: false },
  });
}

// Vite's HTML processing canonicalizes Bazel's source symlinks outside its renderer root.
// A library entry exercises the same renderer without that unrelated HTML-path failure.
await build({
  configFile: false,
  build: {
    outDir: `${output}/renderer`,
    lib: { entry: 'src/renderer/index.ts', formats: ['es'], fileName: () => 'index.js' },
  },
});
await writeFile(
  `${output}/renderer/index.html`,
  '<!doctype html><html><body><script type="module" src="./index.js"></script></body></html>'
);
