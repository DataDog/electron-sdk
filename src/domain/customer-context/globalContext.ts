import { ContextManager, initContextWithHistory, type Context, type ContextHistory } from './contextManager';
import type { FormatHooks } from '../../assembly';

export const GLOBAL_CONTEXT_HISTORY_FILE_NAME = '_dd_global_context_history';

/**
 * Stores free-form attributes and injects them as `context` into RUM events.
 *
 * Unlike user and account there are no standard fields: every key is customer-defined, so no
 * property is reserved or validated. Per-property setters are exposed here, where they are
 * meaningful, rather than on the base class.
 *
 * Applies to renderer events too; the renderer's Browser SDK has its own global context, and keys
 * it sets win (see `RendererPipeline`).
 */
export class GlobalContext extends ContextManager<Context> {
  static init(hooks: FormatHooks): Promise<GlobalContext> {
    return initContextWithHistory((history) => new GlobalContext(hooks, history), GLOBAL_CONTEXT_HISTORY_FILE_NAME);
  }

  constructor(hooks: FormatHooks, history?: ContextHistory) {
    super('global context', {}, history);
    this.registerRumHook(hooks);
  }

  /** Every key is customer-defined, so `extraInfo` is stored as an ordinary attribute. */
  override setContext(context: Context): void {
    this.setFlatContext(context);
  }

  override setProperty(key: string, value: unknown): void {
    super.setProperty(key, value);
  }

  override removeProperty(key: string): void {
    super.removeProperty(key);
  }
}
