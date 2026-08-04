import { describe, it, expect, beforeEach } from 'vitest';
import { ExecutionContextAttributes } from './ExecutionContextAttributes';

describe('ExecutionContextAttributes', () => {
  let attributes: ExecutionContextAttributes;

  beforeEach(() => {
    attributes = new ExecutionContextAttributes({ id: 'main-id', name: undefined });
  });

  describe('getMainExecutionContext', () => {
    it('returns main execution context with type main-process', () => {
      expect(attributes.getMainExecutionContext()).toEqual({ id: 'main-id', type: 'main-process', name: undefined });
    });
  });

  describe('getRendererExecutionContext', () => {
    it('returns undefined when no renderer registered for webContentsId', () => {
      expect(attributes.getRendererExecutionContext(1)).toBeUndefined();
    });

    it('returns renderer context after setRendererExecutionContext', () => {
      attributes.setRendererExecutionContext(42, { id: 'renderer-uuid', name: undefined });
      expect(attributes.getRendererExecutionContext(42)).toEqual({
        id: 'renderer-uuid',
        type: 'renderer-process',
        name: undefined,
      });
    });

    it('returns undefined after deleteRendererExecutionContext', () => {
      attributes.setRendererExecutionContext(42, { id: 'renderer-uuid', name: undefined });
      attributes.deleteRendererExecutionContext(42);
      expect(attributes.getRendererExecutionContext(42)).toBeUndefined();
    });
  });
});
