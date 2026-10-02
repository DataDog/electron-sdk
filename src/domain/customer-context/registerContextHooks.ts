import { SKIPPED } from '@datadog/js-core/assembly';
import { isEmptyObject } from '@datadog/browser-core';
import type { FormatHooks } from '../../assembly';
import type { TrackingConsentHistory } from '../tracking-consent';
import { toSpanMeta, type Context } from './contextManager';

export type ContextHistory = Pick<TrackingConsentHistory<Context>, 'set' | 'find'>;

/** Uses current customer context for cumulative views and capture-time history for other events. */
export function registerContextHooks(
  hooks: FormatHooks,
  history: ContextHistory,
  getCurrentContext: () => Context,
  key?: 'usr' | 'account'
): void {
  hooks.registerRum(({ eventType, startTime }) => {
    const context = eventType === 'view' ? getCurrentContext() : history.find(startTime);
    if (!context || isEmptyObject(context)) return SKIPPED;
    return key ? { [key]: context } : { context };
  });
  if (!key) return;
  hooks.registerLogs(({ startTime }) => {
    const context = history.find(startTime);
    return context && !isEmptyObject(context) ? { [key]: context } : SKIPPED;
  });
  hooks.registerSpan(({ startTime }) => {
    const context = history.find(startTime);
    return context && !isEmptyObject(context) ? { meta: toSpanMeta(key, context) } : SKIPPED;
  });
}
