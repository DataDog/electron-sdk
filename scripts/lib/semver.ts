export type VersionBump = 'major' | 'minor' | 'patch';

export function bumpVersion(current: string, bump: VersionBump): string {
  // Intentionally only supports stable X.Y.Z versions — pre-release strings (e.g. 1.0.0-beta.1) are not supported.
  const match = current.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) throw new Error(`Invalid semver: ${current}`);
  let major = Number(match[1]);
  let minor = Number(match[2]);
  let patch = Number(match[3]);
  if (bump === 'major') {
    major++;
    minor = 0;
    patch = 0;
  } else if (bump === 'minor') {
    minor++;
    patch = 0;
  } else {
    patch++;
  }
  return `${major}.${minor}.${patch}`;
}
