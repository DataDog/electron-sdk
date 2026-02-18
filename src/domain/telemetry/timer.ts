// These are internal browser-core exports, not part of the public API
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TODO(RUM-14336) expose those APIs from browser-core
import { monitor } from '@datadog/browser-core/cjs/tools/monitor';

export function setTimeout(callback: () => void, delay?: number): ReturnType<typeof global.setTimeout> {
  return global.setTimeout(monitor(callback), delay);
}

export function setInterval(callback: () => void, delay?: number): ReturnType<typeof global.setInterval> {
  return global.setInterval(monitor(callback), delay);
}
