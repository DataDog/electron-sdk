import { DISCARDED, SKIPPED } from '@datadog/browser-core';
import type { FormatHooks } from '../../assembly';

export class SessionContext {
  private currentSessionId: string | undefined;

  constructor(hooks: FormatHooks) {
    hooks.registerRum(() => {
      if (this.currentSessionId === undefined) return DISCARDED;
      return { session: { id: this.currentSessionId } };
    });

    hooks.registerTelemetry(() => {
      if (this.currentSessionId === undefined) return SKIPPED;
      return { session: { id: this.currentSessionId } };
    });
  }

  add(sessionId: string): void {
    this.currentSessionId = sessionId;
  }

  close(): void {
    this.currentSessionId = undefined;
  }
}
