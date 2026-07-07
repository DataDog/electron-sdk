import { beforeEach, describe, expect, it } from 'vitest';
import { ActionCollection } from './ActionCollection';
import { EventFormat, EventKind, EventManager, type RawRumEvent } from '../../../event';
import type { RawRumAction } from '../rawRumData.types';

// Strict RFC 4122 v4 — matches the schema pattern and browser-core's generateUUID output.
const UUID_REGEX = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

describe('ActionCollection', () => {
  let eventManager: EventManager;
  let actionCollection: ActionCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    eventManager = new EventManager();
    rawRumEvents = [];
    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
    actionCollection = new ActionCollection(eventManager);
  });

  describe('payload shape', () => {
    it('emits a custom action event with the full payload shape', () => {
      actionCollection.getApi().addAction('checkout_submitted');

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumAction;
      expect(data.type).toBe('action');
      expect(data.action.type).toBe('custom');
      expect(data.action.target.name).toBe('checkout_submitted');
      expect(data.action.id).toMatch(UUID_REGEX);
    });

    it('forwards context into the event context', () => {
      actionCollection.getApi().addAction('exported', { format: 'pdf', pages: 3 });

      const data = rawRumEvents[0].data as RawRumAction;
      expect(data.context).toEqual({ format: 'pdf', pages: 3 });
    });

    it('defaults context to an empty object when omitted', () => {
      actionCollection.getApi().addAction('login');

      const data = rawRumEvents[0].data as RawRumAction;
      expect(data.context).toEqual({});
    });

    it('produces a unique id per call', () => {
      const api = actionCollection.getApi();
      api.addAction('login');
      api.addAction('login');

      expect(rawRumEvents).toHaveLength(2);
      const firstId = (rawRumEvents[0].data as RawRumAction).action.id;
      const secondId = (rawRumEvents[1].data as RawRumAction).action.id;
      expect(firstId).not.toBe(secondId);
    });

    it('does not attach frustration, loading_time or child-event counts to a custom action', () => {
      actionCollection.getApi().addAction('login');

      const { action } = rawRumEvents[0].data as RawRumAction & { action: Record<string, unknown> };
      expect('frustration' in action).toBe(false);
      expect('loading_time' in action).toBe(false);
      expect('error' in action).toBe(false);
      expect('resource' in action).toBe(false);
      expect('long_task' in action).toBe(false);
    });

    it('captures a non-zero startTime and mirrors it onto data.date', () => {
      const before = Date.now();
      actionCollection.getApi().addAction('login');
      const after = Date.now();

      const event = rawRumEvents[0];
      expect(event.startTime).toBeGreaterThanOrEqual(before);
      expect(event.startTime).toBeLessThanOrEqual(after);
      expect((event.data as RawRumAction).date).toBe(event.startTime);
    });
  });

  // Parity: action names are free text. The browser, iOS and Android SDKs all emit the name verbatim with no
  // emptiness or character-set validation (only operation/vital names — which are facet paths — are validated).
  describe('name handling (free text, no validation)', () => {
    it.each([
      ['empty', ''],
      ['whitespace', '   '],
      ['spaces', 'user clicked export'],
      ['punctuation', "Clicked 'Export' → PDF"],
      ['unicode', 'ログイン'],
      ['long', 'a'.repeat(500)],
    ])('emits the %s name verbatim', (_label, name) => {
      actionCollection.getApi().addAction(name);

      expect(rawRumEvents).toHaveLength(1);
      expect((rawRumEvents[0].data as RawRumAction).action.target.name).toBe(name);
    });
  });

  // Electron intentionally keeps no per-action state in the main process (matches OperationCollection): renderer
  // actions bridged from the browser-sdk would desync any main-side tracking. Every call emits unconditionally.
  describe('no local tracking', () => {
    it('emits one event per call with no cross-call coupling', () => {
      const api = actionCollection.getApi();
      api.addAction('a');
      api.addAction('b');
      api.addAction('a');

      expect(rawRumEvents).toHaveLength(3);
      expect(rawRumEvents.map((e) => (e.data as RawRumAction).action.target.name)).toEqual(['a', 'b', 'a']);
    });
  });

  describe('lifecycle', () => {
    it('stop() is callable without side effects (no owned subscriptions)', () => {
      actionCollection.stop();
      actionCollection.getApi().addAction('login');
      expect(rawRumEvents).toHaveLength(1);
    });
  });
});
