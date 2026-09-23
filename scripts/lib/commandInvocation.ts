import fs from 'node:fs';
import path from 'node:path';

interface CommandInvocationOptions {
  environment?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  nodeExecutable?: string;
}

/** Resolves Windows Yarn shims to JavaScript so bootstrap commands need no shell or installed dependencies. */
export function getCommandInvocation(
  command: string,
  args: string[],
  {
    environment = process.env,
    platform = process.platform,
    nodeExecutable = process.execPath,
  }: CommandInvocationOptions = {}
): { command: string; args: string[] } {
  if (platform !== 'win32' || !/^yarn(?:\.cmd)?$/i.test(command)) return { command, args };

  const activeYarn = environment.npm_execpath;
  if (activeYarn && /^yarn(?:-[^/\\]+)?\.(?:c?js)$/i.test(path.basename(activeYarn)) && fs.existsSync(activeYarn)) {
    return { command: nodeExecutable, args: [activeYarn, ...args] };
  }

  const pathKey = Object.keys(environment).find((key) => key.toLowerCase() === 'path');
  const searchDirectories = [
    ...(pathKey ? (environment[pathKey] ?? '').split(';').filter(Boolean) : []),
    path.dirname(nodeExecutable),
  ];
  for (const directory of searchDirectories) {
    for (const relativeEntryPoint of ['node_modules/corepack/dist/yarn.js', 'node_modules/yarn/bin/yarn.js']) {
      const entryPoint = path.join(directory, relativeEntryPoint);
      if (fs.existsSync(entryPoint)) return { command: nodeExecutable, args: [entryPoint, ...args] };
    }
  }

  throw new Error(
    'Cannot locate the Yarn JavaScript entry point. Install Corepack alongside Node.js or on PATH, or run this script through Yarn.'
  );
}
