import childProcess from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { command } from '../../lib/command.ts';
import { printError } from '../../lib/executionUtils.ts';
import { PLAYGROUND_DIR } from './version.ts';

const RENDERERS = ['renderer', 'secondary-renderer'] as const;
type Renderer = (typeof RENDERERS)[number];
const HTML_PAGES = ['index.html', 'secondary.html'];

const DIST_DIR = path.join(PLAYGROUND_DIR, 'dist');

// Scripts run from the repo root, but typescript and esbuild are playground dependencies. Running tsc's JS entry point
// with Node and using esbuild's JS API avoids the `.bin` shims, which Windows cannot spawn without a shell.
// Resolved lazily so importing this module does not require the playground dependencies to be installed.
const playgroundRequire = () => createRequire(path.join(PLAYGROUND_DIR, 'package.json'));
const resolveTscEntry = () => playgroundRequire().resolve('typescript/bin/tsc');

// The root has no esbuild types, so only the used surface is declared.
interface BuildOptions {
  absWorkingDir: string;
  entryPoints: string[];
  bundle: boolean;
  format: 'esm';
  outfile: string;
  sourcemap: boolean;
  define: Record<string, string>;
  logLevel: 'info';
}
interface Esbuild {
  build(options: BuildOptions): Promise<unknown>;
  context(options: BuildOptions): Promise<{ watch(): Promise<void>; dispose(): Promise<void> }>;
}
const loadEsbuild = () => playgroundRequire()('esbuild') as Esbuild;

export async function buildPlayground(version: string): Promise<void> {
  cleanBuildOutput();
  writeVersionFile(version);
  command`${process.execPath} ${resolveTscEntry()}`.withCurrentWorkingDirectory(PLAYGROUND_DIR).withLogs().run();
  const esbuild = loadEsbuild();
  for (const renderer of RENDERERS) {
    await esbuild.build(rendererBuildOptions(renderer, version));
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

export function rendererBuildOptions(renderer: Renderer, version: string): BuildOptions {
  return {
    absWorkingDir: PLAYGROUND_DIR,
    entryPoints: [`src/${renderer}.ts`],
    bundle: true,
    format: 'esm',
    outfile: `dist/${renderer}.js`,
    sourcemap: true,
    define: { __PLAYGROUND_VERSION__: JSON.stringify(version) },
    logLevel: 'info',
  };
}

function copyHtmlPages(): void {
  for (const page of HTML_PAGES) {
    fs.copyFileSync(path.join(PLAYGROUND_DIR, 'src', page), path.join(DIST_DIR, page));
  }
}

// Long-running watchers: `command` is synchronous, so spawn tsc directly (still without a shell).
export async function watchPlayground(version: string): Promise<void> {
  writeVersionFile(version);
  const esbuild = loadEsbuild();
  const contexts = await Promise.all(
    RENDERERS.map((renderer) => esbuild.context(rendererBuildOptions(renderer, version)))
  );
  const tsc = childProcess.spawn(process.execPath, [resolveTscEntry(), '--watch', '--preserveWatchOutput'], {
    cwd: PLAYGROUND_DIR,
    stdio: 'inherit',
  });

  // Both a signal and the resulting tsc exit trigger a shutdown, so only the first one disposes the contexts.
  let shuttingDown = false;
  const shutdown = (code: number) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    tsc.kill('SIGTERM');
    void Promise.allSettled(contexts.map((context) => context.dispose())).then(() => process.exit(code));
  };
  // Without cleanup, the tsc watcher outlives this process when it is stopped (e.g. by `concurrently` in `yarn dev`).
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => shutdown(0));
  }
  tsc.on('exit', (code) => shutdown(code ?? 1));

  await Promise.all(contexts.map((context) => context.watch())).catch((error: unknown) => {
    printError(error);
    shutdown(1);
  });
}
