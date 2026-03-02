// These are internal browser-core exports, not part of the public API
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import { monitor } from '@datadog/browser-core/cjs/tools/monitor';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import { throttle as coreThrottle } from '@datadog/browser-core/cjs/tools/utils/functionUtils';

export function setTimeout(callback: () => void, delay?: number): ReturnType<typeof global.setTimeout> {
  return global.setTimeout(monitor(callback), delay);
}

export function setInterval(callback: () => void, delay?: number): ReturnType<typeof global.setInterval> {
  return global.setInterval(monitor(callback), delay);
}

export function throttle(
  fn: () => void,
  wait: number,
  options?: { leading?: boolean; trailing?: boolean }
): { throttled: () => void; cancel: () => void } {
  return coreThrottle(monitor(fn), wait, options);
}
