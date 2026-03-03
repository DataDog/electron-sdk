import { DISCARDED, SKIPPED } from '@datadog/browser-core';
import type { FormatHooks } from '../../../assembly';

export interface ViewContextData {
  id: string;
  name: string;
  url: string;
}

export class ViewContext {
  private currentView: ViewContextData | undefined;

  constructor(hooks: FormatHooks) {
    hooks.registerRum(() => {
      if (this.currentView === undefined) return DISCARDED;
      return { view: { id: this.currentView.id, name: this.currentView.name, url: this.currentView.url } };
    });

    hooks.registerTelemetry(() => {
      if (this.currentView === undefined) return SKIPPED;
      return { view: { id: this.currentView.id } };
    });
  }

  add(id: string): void {
    this.currentView = {
      id,
      name: 'main process', // TODO(RUM-14657) improve name / url
      url: 'electron://main-process',
    };
  }

  close(): void {
    this.currentView = undefined;
  }
}
