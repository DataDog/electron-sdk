import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BatchSizes } from '../config';
import type { Event, RawEvent, ServerEvent } from '../event';
import { EventKind, EventTrack, EventManager } from '../event';
import { createTestConfiguration } from '../mocks.specUtil';
import { Transport } from './Transport';
import type { Domain } from './transport.types';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/mock/user/data'),
  },
}));

const mockBatchInit = vi.fn().mockResolvedValue(undefined);
const mockBatchPost = vi.fn();
const mockBatchFlush = vi.fn().mockResolvedValue(undefined);

vi.mock('./batch', () => ({
  BatchManager: vi.fn().mockImplementation(function () {
    return {
      init: mockBatchInit,
      post: mockBatchPost,
      flush: mockBatchFlush,
      stop: vi.fn(),
    };
  }),
}));

function createMockDomain(trackType: string): Domain {
  return {
    trackType: trackType as (typeof EventTrack)[keyof typeof EventTrack],
    init: vi.fn(),
  };
}

describe('Transport', () => {
  let eventManager: EventManager;
  let config: ReturnType<typeof createTestConfiguration>;

  beforeEach(() => {
    vi.clearAllMocks();
    eventManager = new EventManager();
    config = createTestConfiguration();
  });

  describe('register', () => {
    it('should register event handlers for each domain', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const spy = vi.spyOn(eventManager, 'registerHandler');
      const transport = new Transport(config, eventManager, [rumDomain]);
      await transport.init();

      expect(spy).toHaveBeenCalled();
    });

    it('should setup batch manager for each domain', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      expect(mockBatchInit).toHaveBeenCalled();
    });

    it('should use custom path when provided', () => {
      const customPath = '/custom/path';
      const transport = new Transport(config, eventManager, [], customPath);

      expect(transport).toBeDefined();
    });

    it('should register a domain', async () => {
      const transport = new Transport(config, eventManager);
      const rumDomain = createMockDomain(EventTrack.RUM);

      transport.register(rumDomain);
      await transport.init();

      expect(mockBatchInit).toHaveBeenCalled();
    });

    it('should not register duplicate domains', async () => {
      const transport = new Transport(config, eventManager);
      const rumDomain = createMockDomain(EventTrack.RUM);

      transport.register(rumDomain);
      transport.register(rumDomain);
      await transport.init();

      expect(mockBatchInit).toHaveBeenCalledTimes(1);
    });
  });

  describe('event handling', () => {
    it('should handle SERVER events matching domain track type', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      const handler = eventManager['handlers'][0];
      const serverEvent = {
        kind: EventKind.SERVER,
        track: EventTrack.RUM,
        data: { test: 'data' },
      } as unknown as ServerEvent;

      expect(handler.canHandle(serverEvent)).toBe(true);
      handler.handle(serverEvent, () => ({}));

      expect(mockBatchPost).toHaveBeenCalledWith({ test: 'data' });
    });

    it('should not handle events that do not match', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      const handler = eventManager['handlers'][0];
      const rawEvent = {
        kind: EventKind.RAW,
        source: 'main-process',
        data: { test: 'data' },
      } as unknown as RawEvent;

      expect(handler.canHandle(rawEvent)).toBe(false);
    });

    it('should not handle SERVER events with different track type', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      const handler = eventManager['handlers'][0];
      const logsEvent: Event = {
        kind: EventKind.SERVER,
        track: EventTrack.LOGS,
        data: { test: 'data' },
      };

      expect(handler.canHandle(logsEvent)).toBe(false);
    });
  });

  describe('flush', () => {
    it('should flush all batch managers', async () => {
      const rumDomain = createMockDomain(EventTrack.RUM);
      const logsDomain = createMockDomain(EventTrack.LOGS);
      const transport = new Transport(config, eventManager, [rumDomain, logsDomain]);

      await transport.init();
      await transport.flush();

      expect(mockBatchFlush).toHaveBeenCalledTimes(2);
    });
  });

  describe('batch configuration', () => {
    it('should use default batch size when not specified', async () => {
      const { BatchManager } = await import('./batch');
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      expect(BatchManager).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          batchSize: BatchSizes.MEDIUM,
        })
      );
    });

    it('should use configured batch size', async () => {
      const { BatchManager } = await import('./batch');
      const configWithBatchSize = createTestConfiguration({ batchSize: 'SMALL' });
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(configWithBatchSize, eventManager, [rumDomain]);

      await transport.init();

      expect(BatchManager).toHaveBeenCalledWith(
        configWithBatchSize,
        expect.objectContaining({
          batchSize: BatchSizes.SMALL,
        })
      );
    });

    it('should use default upload frequency when not specified', async () => {
      const { BatchManager } = await import('./batch');
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(config, eventManager, [rumDomain]);

      await transport.init();

      expect(BatchManager).toHaveBeenCalledWith(
        config,
        expect.objectContaining({
          uploadFrequency: 10 * 1000, // NORMAL
        })
      );
    });

    it('should use configured upload frequency', async () => {
      const { BatchManager } = await import('./batch');
      const configWithFrequency = createTestConfiguration({ uploadFrequency: 'FREQUENT' });
      const rumDomain = createMockDomain(EventTrack.RUM);
      const transport = new Transport(configWithFrequency, eventManager, [rumDomain]);

      await transport.init();

      expect(BatchManager).toHaveBeenCalledWith(
        configWithFrequency,
        expect.objectContaining({
          // TODO
          uploadFrequency: 5 * 1000, // FREQUENT
        })
      );
    });
  });
});
