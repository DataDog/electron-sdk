// These are internal browser-core exports, not part of the public API
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import { monitor } from '@datadog/browser-core/cjs/tools/monitor';

export function setTimeout(callback: () => void, delay?: number): ReturnType<typeof global.setTimeout> {
  return global.setTimeout(monitor(callback), delay);
}

// Paired with setTimeout so timer usage goes through this module rather than reaching for the
// globals directly. There is no callback to wrap here, so it simply delegates to global.clearTimeout.
export function clearTimeout(timeoutId: ReturnType<typeof global.setTimeout> | undefined): void {
  global.clearTimeout(timeoutId);
}

export function setInterval(callback: () => void, delay?: number): ReturnType<typeof global.setInterval> {
  return global.setInterval(monitor(callback), delay);
}

// Paired with setInterval so timer usage goes through this module rather than reaching for the
// globals directly. There is no callback to wrap here, so it simply delegates to global.clearInterval.
export function clearInterval(intervalId: ReturnType<typeof global.setInterval> | undefined): void {
  global.clearInterval(intervalId);
}
