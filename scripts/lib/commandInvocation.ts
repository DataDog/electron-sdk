import fs from 'node:fs';
import path from 'node:path';

interface CommandInvocationOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

/** Resolves Windows Yarn and npm shims to JavaScript so bootstrap commands need no shell or installed dependencies. */
export function getCommandInvocation(
  command: string,
  args: string[],
  {
    environment = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
  }: CommandInvocationOptions = {}
): { command: string; args: string[] } {
  const packageManager = /^(yarn|npm)(?:\.cmd)?$/i.exec(command)?.[1].toLowerCase();
  if (platform !== 'win32' || !packageManager) return { command, args };

  const cliName = packageManager === 'yarn' ? 'Yarn' : 'npm';
  const entryPointPattern = packageManager === 'yarn' ? /^yarn(?:-[^/\\]+)?\.(?:c?js)$/i : /^npm-cli\.js$/i;
  const activeCli = environment.npm_execpath;
  if (activeCli && entryPointPattern.test(path.basename(activeCli)) && fs.existsSync(activeCli)) {
    return { command: nodeExecutable, args: [activeCli, ...args] };
  }

  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const searchDirectories = [
    ...(pathKey ? (environment[pathKey] ?? '').split(';').filter(Boolean) : []),
    path.dirname(nodeExecutable),
  ];
  const entryPoints =
    packageManager === 'yarn'
      ? ['node_modules/corepack/dist/yarn.js', 'node_modules/yarn/bin/yarn.js']
      : ['node_modules/npm/bin/npm-cli.js'];
  for (const directory of searchDirectories) {
    for (const relativeEntryPoint of entryPoints) {
      const entryPoint = path.join(directory, relativeEntryPoint);
      if (fs.existsSync(entryPoint)) return { command: nodeExecutable, args: [entryPoint, ...args] };
    }
  }

  throw new Error(
    `Cannot locate the ${cliName} JavaScript entry point. Install ${packageManager === 'yarn' ? 'Corepack' : 'npm'} alongside Node.js or on PATH, or run this script through ${cliName}.`
  );
}
