import type { EventManager } from '../../../event';
import type { FormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import type { ContextHistoryFactory, TrackingConsentManager } from '../../tracking-consent';
import { MainProcessContext } from './MainProcessContext';
import { RendererProcessContexts } from './RendererProcessContexts';

/**
 * Orchestrates execution-context tracking for main and renderer processes: starts and stops a session-scoped
 * MainProcessContext for the main process alongside a RendererProcessContexts for every renderer
 * webContents.
 */
export class ExecutionContextCollection {
  private constructor(
    private readonly mainProcessContext: MainProcessContext,
    private readonly rendererProcessContexts: RendererProcessContexts
  ) {}

  static async start(
    eventManager: EventManager,
    hooks: FormatHooks,
    sessionManager: SessionManager,
    histories: ContextHistoryFactory,
    trackingConsentManager: TrackingConsentManager
  ): Promise<ExecutionContextCollection> {
    const mainProcessContext = await MainProcessContext.start(
      eventManager,
      hooks,
      sessionManager,
      histories,
      trackingConsentManager
    );
    const rendererProcessContexts = RendererProcessContexts.start(eventManager, hooks, trackingConsentManager);
    return new ExecutionContextCollection(mainProcessContext, rendererProcessContexts);
  }

  stop(): void {
    this.mainProcessContext.stop();
    this.rendererProcessContexts.stop();
  }
}
