import fs from 'node:fs';
import path from 'node:path';
import { command } from './command.ts';

export interface PackageJsonInfo {
  relativePath: string;
  path: string;
  content: any;
}

export function findPackageJsonFiles(): PackageJsonInfo[] {
  const manifestPaths = command`git ls-files -- package.json */package.json`.run();
  return manifestPaths
    .trim()
    .split('\n')
    .map((manifestPath) => {
      const absoluteManifestPath = path.join(import.meta.dirname, '../..', manifestPath);
      return {
        relativePath: manifestPath,
        path: absoluteManifestPath,
        content: JSON.parse(fs.readFileSync(absoluteManifestPath, 'utf-8')),
      };
    });
}
