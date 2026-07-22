import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessContext } from './ProcessContext';

describe('ProcessContext', () => {
  let ctx: ProcessContext;

  beforeEach(() => {
    ctx = new ProcessContext({ id: 'main-id', name: undefined });
  });

  describe('getMainProcessContext', () => {
    it('returns main process context with role main', () => {
      expect(ctx.getMainProcessContext()).toEqual({ id: 'main-id', role: 'main', name: undefined });
    });
  });

  describe('getRendererProcessContext', () => {
    it('returns undefined when no renderer registered for webContentsId', () => {
      expect(ctx.getRendererProcessContext(1)).toBeUndefined();
    });

    it('returns renderer context after setRendererProcess', () => {
      ctx.setRendererProcess(42, { id: 'renderer-uuid', name: undefined });
      expect(ctx.getRendererProcessContext(42)).toEqual({
        id: 'renderer-uuid',
        role: 'renderer',
        name: undefined,
      });
    });

    it('returns undefined after deleteRendererProcess', () => {
      ctx.setRendererProcess(42, { id: 'renderer-uuid', name: undefined });
      ctx.deleteRendererProcess(42);
      expect(ctx.getRendererProcessContext(42)).toBeUndefined();
    });
  });
});
