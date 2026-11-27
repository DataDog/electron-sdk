export function isMissingPath(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

export function isLockedFile(error: unknown): boolean {
  // On Windows, deleting a file another process holds open fails with EPERM too; elsewhere EPERM is a lasting refusal
  return hasErrorCode(error, 'EBUSY') || (process.platform === 'win32' && hasErrorCode(error, 'EPERM'));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
