export function correctedChildSampleRate(parentRate: number, childRate: number): number {
  return (parentRate * childRate) / 100;
}

export function isSessionSampled(sessionId: string, sampleRate: number): boolean {
  if (sampleRate >= 100) return true;
  if (sampleRate <= 0) return false;

  const lastSegment = sessionId.split('-')[4];
  if (!lastSegment || !/^[0-9a-f]{12}$/i.test(lastSegment)) return false;

  return sampleUsingKnuthFactor(BigInt('0x' + lastSegment), sampleRate);
}

function sampleUsingKnuthFactor(identifier: bigint, sampleRate: number): boolean {
  const knuthFactor = BigInt('1111111111111111111');
  const twoPow64 = BigInt('0x10000000000000000');
  const hash = (identifier * knuthFactor) % twoPow64;
  return Number(hash) <= (sampleRate / 100) * Number(twoPow64);
}
