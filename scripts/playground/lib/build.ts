import childProcess from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { command } from '../../lib/command.ts';
import { PLAYGROUND_DIR } from './version.ts';

const RENDERERS = ['renderer', 'secondary-renderer'] as const;
type Renderer = (typeof RENDERERS)[number];
const HTML_PAGES = ['index.html', 'secondary.html'];

const DIST_DIR = path.join(PLAYGROUND_DIR, 'dist');
const bin = (name: string) => path.join(PLAYGROUND_DIR, 'node_modules', '.bin', name);

export function buildPlayground(version: string): void {
  cleanBuildOutput();
  writeVersionFile(version);
  command`${bin('tsc')}`.withCurrentWorkingDirectory(PLAYGROUND_DIR).withLogs().run();
  for (const renderer of RENDERERS) {
    command`${bin('esbuild')} ${rendererBuildArgs(renderer, version, false)}`
      .withCurrentWorkingDirectory(PLAYGROUND_DIR)
      .withLogs()
      .run();
  }
  copyHtmlPages();
}

// The upload sends every map in dist/, so leftovers from earlier builds must not survive. The tsc build info lives
// outside dist/ and would otherwise make incremental tsc skip re-emitting the deleted files.
export function cleanBuildOutput(playgroundDir = PLAYGROUND_DIR): void {
  fs.rmSync(path.join(playgroundDir, 'dist'), { recursive: true, force: true });
  fs.rmSync(path.join(playgroundDir, 'tsconfig.tsbuildinfo'), { force: true });
}

// Read by the main process at startup (see playground/src/main/version.ts), so it reports the version the renderers
// were built with even when run without PLAYGROUND_VERSION.
export function writeVersionFile(version: string, distDir = DIST_DIR): void {
  fs.mkdirSync(distDir, { recursive: true });
  fs.writeFileSync(path.join(distDir, 'version.json'), `${JSON.stringify({ version })}\n`);
}

export function rendererBuildArgs(renderer: Renderer, version: string, watch: boolean): string[] {
  return [
    `src/${renderer}.ts`,
    '--bundle',
    '--format=esm',
    `--outfile=dist/${renderer}.js`,
    '--sourcemap',
    `--define:__PLAYGROUND_VERSION__=${JSON.stringify(version)}`,
    ...(watch ? ['--watch'] : []),
  ];
}

function copyHtmlPages(): void {
  for (const page of HTML_PAGES) {
    fs.copyFileSync(path.join(PLAYGROUND_DIR, 'src', page), path.join(DIST_DIR, page));
  }
}

// Long-running watchers: `command` is synchronous, so spawn them directly (still without a shell).
export function watchPlayground(version: string): void {
  writeVersionFile(version);
  // The piped stdin closes with this process, which makes esbuild stop even when its `.bin` wrapper is killed
  // without forwarding the signal to the native binary.
  const spawnWatcher = (binary: string, args: string[]) =>
    childProcess.spawn(bin(binary), args, { cwd: PLAYGROUND_DIR, stdio: ['pipe', 'inherit', 'inherit'] });
  const watchers = [
    spawnWatcher('tsc', ['--watch', '--preserveWatchOutput']),
    ...RENDERERS.map((renderer) => spawnWatcher('esbuild', rendererBuildArgs(renderer, version, true))),
  ];

  // Without forwarding, the watchers outlive this process when it is stopped (e.g. by `concurrently` in `yarn dev`).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => watchers.forEach((watcher) => watcher.kill(signal)));
  }
  for (const watcher of watchers) {
    watcher.on('exit', (code) => {
      watchers.forEach((other) => other.kill('SIGTERM'));
      process.exit(code ?? 1);
    });
  }
}
