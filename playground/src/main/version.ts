import * as fs from 'node:fs';
import * as path from 'node:path';

// Written by the build (scripts/playground/lib/build.ts) so main reports the version the renderers were built with.
// A missing file means a broken build: fail at startup rather than report a version the uploaded maps don't match.
export function readPlaygroundVersion(): string {
  const versionFile = path.join(__dirname, '..', 'version.json');
  return (JSON.parse(fs.readFileSync(versionFile, 'utf8')) as { version: string }).version;
}
