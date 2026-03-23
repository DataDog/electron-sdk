import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCollection } from './ErrorCollection';
import { EventFormat, EventKind, EventManager, type RawRumEvent } from '../../event';
import type { RawRumError } from './rawRumData.types';

describe('ErrorCollection', () => {
  let eventManager: EventManager;
  let errorCollection: ErrorCollection;
  let rawRumEvents: RawRumEvent[];

  beforeEach(() => {
    eventManager = new EventManager();
    rawRumEvents = [];

    eventManager.registerHandler<RawRumEvent>({
      canHandle: (event): event is RawRumEvent => event.kind === EventKind.RAW && event.format === EventFormat.RUM,
      handle: (event) => rawRumEvents.push(event),
    });
  });

  afterEach(() => {
    errorCollection.stop();
  });

  describe('uncaughtException', () => {
    it('emits an error event with correct fields from an Error object', () => {
      errorCollection = new ErrorCollection(eventManager);

      process.emit('uncaughtException', new Error('test error'));

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.type).toBe('error');
      expect(data.error.message).toBe('test error');
      expect(data.error.source).toBe('source');
      expect(data.error.handling).toBe('unhandled');
      expect(data.error.type).toBe('Error');
      expect(data.error.stack).toBeDefined();
      expect(data.error.id).toBeDefined();
    });

    it('emits an error event with fallback message from a non-Error value', () => {
      errorCollection = new ErrorCollection(eventManager);

      process.emit('uncaughtException', 'string error' as unknown as Error);

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Uncaught "string error"');
      expect(data.error.stack).toBeUndefined();
      expect(data.error.type).toBeUndefined();
    });
  });

  describe('unhandledRejection', () => {
    it('emits an error event with correct fields from an Error rejection', () => {
      errorCollection = new ErrorCollection(eventManager);

      process.emit('unhandledRejection', new Error('test rejection'), Promise.resolve());

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('test rejection');
      expect(data.error.source).toBe('source');
      expect(data.error.handling).toBe('unhandled');
      expect(data.error.stack).toBeDefined();
    });

    it('emits an error event with fallback message from a non-Error rejection', () => {
      errorCollection = new ErrorCollection(eventManager);

      process.emit('unhandledRejection', 'string rejection', Promise.resolve());

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Uncaught "string rejection"');
      expect(data.error.stack).toBeUndefined();
    });
  });

  describe('getApi().addError', () => {
    it('emits an error event with handling: handled and source: custom', () => {
      errorCollection = new ErrorCollection(eventManager);

      errorCollection.getApi().addError(new Error('manual error'));

      expect(rawRumEvents).toHaveLength(1);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.type).toBe('error');
      expect(data.error.message).toBe('manual error');
      expect(data.error.source).toBe('custom');
      expect(data.error.handling).toBe('handled');
      expect(data.error.type).toBe('Error');
      expect(data.error.stack).toBeDefined();
      expect(data.error.id).toBeDefined();
    });

    it('emits an error event with custom context', () => {
      errorCollection = new ErrorCollection(eventManager);

      errorCollection.getApi().addError(new Error('manual error'), { context: { key: 'value' } });

      const data = rawRumEvents[0].data as RawRumError;
      expect(data.context).toEqual({ key: 'value' });
    });

    it('emits an error event with custom startTime', () => {
      errorCollection = new ErrorCollection(eventManager);

      errorCollection.getApi().addError(new Error('manual error'), { startTime: 1234567890 });

      expect(rawRumEvents[0].startTime).toBe(1234567890);
      const data = rawRumEvents[0].data as RawRumError;
      expect(data.date).toBe(1234567890);
    });

    it('emits an error event with fallback message from a non-Error value', () => {
      errorCollection = new ErrorCollection(eventManager);

      errorCollection.getApi().addError('string error');

      const data = rawRumEvents[0].data as RawRumError;
      expect(data.error.message).toBe('Provided "string error"');
      expect(data.error.source).toBe('custom');
      expect(data.error.handling).toBe('handled');
    });
  });
});
