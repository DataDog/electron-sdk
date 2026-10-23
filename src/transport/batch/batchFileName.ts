/**
 * Compares batch file names by age (oldest first).
 *
 * Names embed a timestamp and an unpadded sequence (`<prefix>-<ms>-<seq>`, where the prefix is the
 * track, e.g. `batch` or `profile`), so ordering needs a numeric-aware compare — a plain lexical sort
 * ranks `-10` before `-9`. Centralized here so the producer (eviction) and consumer (upload order)
 * stay in lockstep if the naming ever changes.
 */
export function compareBatchFileNames(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true });
}
