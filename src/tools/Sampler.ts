/**
 * Deterministic session sampler.
 *
 * Parses the last 12-hex-character segment of a UUID (48 random bits) and
 * checks whether it falls below the proportional threshold for sampleRate.
 * Produces the same decision for the same UUID, enabling replay correlation
 * later when replaySampleRate is added.
 */
export function isSessionSampled(sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;

  const lastSegment = sessionId.split('-').pop();
  if (!lastSegment || !/^[0-9a-f]{12}$/i.test(lastSegment)) return false;
  const id = BigInt('0x' + lastSegment);
  const maxId = 0xffffffffffffn;
  const threshold = (maxId * BigInt(Math.round(sampleRate))) / 100n;

  return id < threshold;
}
