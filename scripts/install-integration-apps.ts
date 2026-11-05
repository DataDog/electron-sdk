/** Installs and packages every maintained integration app in each supported plugin configuration. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { command } from './lib/command.ts';
import { materializeApp } from './lib/compatibility.ts';
import { getIntegrationVariantEnvironment, loadIntegrationVariants } from './lib/integrationVariants.ts';
import { printLog, runMain } from './lib/executionUtils.ts';

const appsDir = path.join(import.meta.dirname, '../e2e/integration/apps');
const generatedDir = path.join(appsDir, '../generated');
const packageOutputDirectories = ['dist', 'out', '.vite', '.webpack'];

runMain(async () => {
  fs.rmSync(generatedDir, { recursive: true, force: true });
  const apps = fs.readdirSync(appsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  for (const { name: app } of apps) {
    const source = path.join(appsDir, app);
    for (const variant of loadIntegrationVariants()) {
      const appDir = variant.name === 'default' ? source : path.join(generatedDir, `${app}-${variant.name}`);
      if (variant.name !== 'default') {
        await materializeApp(source, appDir, undefined, 'file:../../integration-sdk.tgz');
      }
      const generatedFiles =
        variant.name !== 'default'
          ? []
          : ['yarn.lock', '.yarnrc.yml']
              .filter((fileName) => fs.existsSync(path.join(appDir, fileName)))
              .map((fileName) => {
                const filePath = path.join(appDir, fileName);
                return { filePath, contents: fs.readFileSync(filePath) };
              });
      const environment = getIntegrationVariantEnvironment(variant);
      try {
        printLog(`\n=== Installing ${app} (${variant.name}) ===`);
        command`yarn install --no-immutable`
          .withCurrentWorkingDirectory(appDir)
          .withEnvironment(environment)
          .withLogs()
          .run();
        printLog(`\n=== Packaging ${app} (${variant.name}) ===`);
        for (const outputDirectory of packageOutputDirectories) {
          fs.rmSync(path.join(appDir, outputDirectory), { recursive: true, force: true });
        }
        command`yarn package`.withCurrentWorkingDirectory(appDir).withEnvironment(environment).withLogs().run();
      } finally {
        for (const { filePath, contents } of generatedFiles) fs.writeFileSync(filePath, contents);
      }
    }
  }
  printLog('\nAll integration apps and option variants ready.');
});
