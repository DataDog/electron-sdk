import type { EventManager } from '../../../event';
import type { FormatHooks } from '../../../assembly';
import type { SessionManager } from '../../session';
import { MainProcessContext } from './MainProcessContext';
import { RendererProcessContexts } from './RendererProcessContexts';
import type { FeatureFlagsForEvents } from '../../../config';

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
    trackFeatureFlagsForEvents: readonly FeatureFlagsForEvents[] = []
  ): Promise<ExecutionContextCollection> {
    const mainProcessContext = await MainProcessContext.start(
      eventManager,
      hooks,
      sessionManager,
      trackFeatureFlagsForEvents
    );
    const rendererProcessContexts = RendererProcessContexts.start(eventManager, hooks);
    return new ExecutionContextCollection(mainProcessContext, rendererProcessContexts);
  }

  stop(): void {
    this.mainProcessContext.stop();
    this.rendererProcessContexts.stop();
  }

  getApi() {
    return this.mainProcessContext.getApi();
  }
}
