import * as fs from 'node:fs';
import * as readline from 'node:readline';
import * as path from 'node:path';
import { printLog, printError, runMain } from './lib/executionUtils.ts';

const pkg = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
  volta: { node: string };
};

runMain(async () => {
  printLog('Check that node versions across configurations are matching...\n');

  const dockerVersion = await retrieveDockerVersion();
  printLog(`docker: ${dockerVersion}`);

  const voltaVersion = pkg.volta.node;
  printLog(`volta: ${voltaVersion}`);

  const processVersion = retrieveProcessVersion();
  printLog(`process: ${processVersion}`);

  if (dockerVersion !== voltaVersion || dockerVersion !== processVersion) {
    printError('Different node versions detected!\n');
    printError('Ensure to:');
    printError(`- run 'volta pin node@${dockerVersion}'`);
    printError("- bump 'CI_IMAGE' and run the 'build-container-image' gitlab job\n");
    process.exit(1);
  }
});

async function retrieveDockerVersion(): Promise<string> {
  const fileStream = fs.createReadStream(path.join(import.meta.dirname, '..', 'Dockerfile'));
  const rl = readline.createInterface({ input: fileStream });
  try {
    for await (const line of rl) {
      if (/^FROM node:\S+$/.test(line)) {
        return extractVersion(line);
      }
    }
  } finally {
    rl.close();
  }
  throw new Error('Could not find node version in Dockerfile');
}

function retrieveProcessVersion(): string {
  // process.version returns vX.Y.Z
  return extractVersion(process.version);
}

function extractVersion(input: string): string {
  const match = /\d+\.\d+\.\d+/.exec(input);
  if (!match) {
    throw new Error(`Could not extract version from: ${input}`);
  }
  return match[0];
}
