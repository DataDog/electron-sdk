import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import type { BatchProducerConfig } from '../BatchProducer';
import { mockFs } from '../../../mocks.specUtil';
import { ReplayBatchProducer } from './ReplayBatchProducer';
import { CreationReason } from '../../../domain/replay';
import type { ReplaySegmentPayload, SegmentMetadata } from '../../../domain/replay';
import { EventKind, EventTrack, type ServerReplayEvent } from '../../../event';

vi.mock('node:fs/promises');
// The batch filename generator uses dateNow from @datadog/js-core/time (not browser-core). Mock that
// module for a deterministic timestamp, preserving its other exports; replacing @datadog/browser-core
// here would break transitive imports that pull real browser-core exports (e.g. performDraw) in.
vi.mock('@datadog/js-core/time', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@datadog/js-core/time')>()),
  dateNow: vi.fn(() => 1234567890),
}));

const fsMocks = mockFs();

const config: BatchProducerConfig = {
  trackPath: '/mock/replay',
};

function makePayload(overrides: Partial<ReplaySegmentPayload> = {}): ReplaySegmentPayload {
  const metadata: SegmentMetadata = {
    application: { id: 'app-1' },
    session: { id: 'sess-1' },
    view: { id: 'view-1' },
    start: 1000,
    end: 2000,
    records_count: 3,
    has_full_snapshot: true,
    index_in_view: 0,
    source: 'browser',
    creation_reason: CreationReason.INIT,
  };
  return {
    metadata,
    rawBytesCount: 256,
    compressed: Buffer.from([0x78, 0x9c, 0x01, 0x02, 0x03]),
    ...overrides,
  };
}

function makeEvent(data = makePayload()): ServerReplayEvent {
  return {
    kind: EventKind.SERVER,
    track: EventTrack.REPLAY,
    data,
  };
}

describe('ReplayBatchProducer', () => {
  beforeEach(() => {
    fsMocks.reset();
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
  });

  describe('create()', () => {
    it('creates the track directory when it does not exist', async () => {
      fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));
      await ReplayBatchProducer.create(config);
      expect(fsMocks.mkdir).toHaveBeenCalledWith(config.trackPath, { recursive: true });
    });

    it('does not create directory when it already exists', async () => {
      await ReplayBatchProducer.create(config);
      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });

    it('rotates orphaned .tmp files from previous sessions', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['batch-111.tmp', 'batch-222.tmp']);
      await ReplayBatchProducer.create(config);
      expect(fsMocks.rename).toHaveBeenCalledTimes(2);
    });
  });

  describe('writeData() — file format', () => {
    it('writes metadata JSON as line 1 and base64-encoded compressed data as line 2', async () => {
      const producer = await ReplayBatchProducer.create(config);
      const payload = makePayload();

      producer.post(makeEvent(payload));
      await producer.flush();

      expect(fsMocks.writeFile).toHaveBeenCalledOnce();
      const [, content] = fsMocks.writeFile.mock.calls[0] as [string, string, string];
      const lines = content.split('\n').filter(Boolean);

      expect(lines).toHaveLength(2);

      // Line 1: JSON metadata with size fields injected
      const meta = JSON.parse(lines[0]) as Record<string, unknown>;
      expect((meta['session'] as { id: string }).id).toBe('sess-1');
      expect((meta['view'] as { id: string }).id).toBe('view-1');
      expect(meta['raw_segment_size']).toBe(payload.rawBytesCount);
      expect(meta['compressed_segment_size']).toBe(payload.compressed.byteLength);
      expect(meta['records_count']).toBe(3);

      // Line 2: base64-encoded compressed data
      expect(Buffer.from(lines[1], 'base64').equals(payload.compressed)).toBe(true);
    });

    it('writes to a .tmp file then atomically renames it to .log', async () => {
      const producer = await ReplayBatchProducer.create(config);
      producer.post(makeEvent());
      await producer.flush();

      const [tmpPath] = fsMocks.writeFile.mock.calls[0] as [string, string, string];
      const [fromPath, toPath] = fsMocks.rename.mock.calls[fsMocks.rename.mock.calls.length - 1] as [string, string];

      expect(tmpPath).toMatch(/\.tmp$/);
      expect(fromPath).toBe(tmpPath);
      expect(toPath).toMatch(/\.log$/);
      expect(path.dirname(toPath)).toBe(config.trackPath);
    });

    it('each post creates a separate file', async () => {
      const producer = await ReplayBatchProducer.create(config);
      producer.post(makeEvent());
      producer.post(makeEvent());
      await producer.flush();

      expect(fsMocks.writeFile).toHaveBeenCalledTimes(2);
      expect(fsMocks.rename).toHaveBeenCalledTimes(2);
    });
  });
});
