import { describe, it, expect } from 'vitest';
import { Segment, type BrowserRecord } from './Segment';

const CONTEXT = { application: { id: 'app-1' }, session: { id: 'sess-1' }, view: { id: 'view-1' } };

function makeRecord(overrides: Partial<BrowserRecord> = {}): BrowserRecord {
  return { type: 3, timestamp: 1000, data: { source: 0 }, ...overrides };
}

describe('Segment', () => {
  describe('initial state', () => {
    it('starts empty', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      expect(segment.isEmpty).toBe(true);
      expect(segment.recordsCount).toBe(0);
    });
  });

  describe('addRecord()', () => {
    it('tracks record count', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord());
      segment.addRecord(makeRecord());
      expect(segment.recordsCount).toBe(2);
      expect(segment.isEmpty).toBe(false);
    });

    it('tracks start and end timestamps across out-of-order records', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord({ timestamp: 500 }));
      segment.addRecord(makeRecord({ timestamp: 300 }));
      segment.addRecord(makeRecord({ timestamp: 700 }));
      const { metadata } = segment.flush();
      expect(metadata.start).toBe(300);
      expect(metadata.end).toBe(700);
    });

    it('does not set has_full_snapshot for non-snapshot records', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord({ type: 3 }));
      expect(segment.flush().metadata.has_full_snapshot).toBe(false);
    });

    it('sets has_full_snapshot when a type-2 record is added', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord({ type: 2 }));
      expect(segment.flush().metadata.has_full_snapshot).toBe(true);
    });

    it('accumulates estimated size proportional to record count', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      expect(segment.estimatedSize).toBe(0);
      segment.addRecord(makeRecord());
      const sizeAfterOne = segment.estimatedSize;
      segment.addRecord(makeRecord());
      expect(segment.estimatedSize).toBeGreaterThan(sizeAfterOne);
    });
  });

  describe('flush()', () => {
    it('embeds context and segment config in metadata', () => {
      const segment = new Segment(CONTEXT, 'view_change', 3);
      segment.addRecord(makeRecord());
      const { metadata } = segment.flush();
      expect(metadata.application.id).toBe('app-1');
      expect(metadata.session.id).toBe('sess-1');
      expect(metadata.view.id).toBe('view-1');
      expect(metadata.creation_reason).toBe('view_change');
      expect(metadata.index_in_view).toBe(3);
      expect(metadata.source).toBe('browser');
    });

    it('produces valid JSON with records array merged with metadata', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      const record = makeRecord({ timestamp: 1000 });
      segment.addRecord(record);

      const { serializedSegment } = segment.flush();
      const parsed = JSON.parse(serializedSegment) as Record<string, unknown>;

      expect(Array.isArray(parsed['records'])).toBe(true);
      expect((parsed['records'] as unknown[]).length).toBe(1);
      expect((parsed['records'] as unknown[])[0]).toEqual(record);
      // Metadata fields are merged at the top level (not nested)
      expect(parsed['application']).toEqual({ id: 'app-1' });
      expect(parsed['records_count']).toBe(1);
    });

    it('serialized segment ends with a newline', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord());
      const { serializedSegment } = segment.flush();
      expect(serializedSegment.endsWith('\n')).toBe(true);
    });

    it('rawBytesCount matches the byte length of the serialized segment', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord());
      const { serializedSegment, rawBytesCount } = segment.flush();
      expect(rawBytesCount).toBe(Buffer.byteLength(serializedSegment, 'utf8'));
    });

    it('returns a snapshot of metadata (not a live reference)', () => {
      const segment = new Segment(CONTEXT, 'init', 0);
      segment.addRecord(makeRecord({ timestamp: 1000 }));
      const first = segment.flush();

      // After flush, adding more records to a new segment should not affect the snapshot
      const segment2 = new Segment(CONTEXT, 'init', 0);
      segment2.addRecord(makeRecord({ timestamp: 9999 }));
      const second = segment2.flush();

      expect(first.metadata.start).toBe(1000);
      expect(second.metadata.start).toBe(9999);
    });
  });
});
