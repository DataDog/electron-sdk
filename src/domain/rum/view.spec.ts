import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ViewCollection } from './view';
import { EventManager, EventKind, EventFormat, type RawRumEvent } from '../../event';
import { createFormatHooks, type FormatHooks } from '../../assembly';

describe('ViewCollection', () => {
  let eventManager: EventManager;
  let hooks: FormatHooks;
  let viewCollection: ViewCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    vi.useFakeTimers();
    eventManager = new EventManager();
    hooks = createFormatHooks();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
  });

  afterEach(() => {
    viewCollection.stop();
    vi.useRealTimers();
  });

  describe('initial view event', () => {
    it('emits initial view event on creation', () => {
      viewCollection = new ViewCollection(eventManager, hooks);

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data;
      expect(data.type).toBe('view');
      expect(data._dd.document_version).toBe(1);
      expect(data.view.is_active).toBe(true);
      expect(data.view.action.count).toBe(0);
      expect(data.view.error.count).toBe(0);
      expect(data.view.resource.count).toBe(0);
    });
  });
});
