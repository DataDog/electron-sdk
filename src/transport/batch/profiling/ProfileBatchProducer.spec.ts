import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { ProfileBatchProducer } from './ProfileBatchProducer';
import { mockFs } from '../../../mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('@datadog/browser-core', () => ({ dateNow: vi.fn(() => 1000) }));

const fsMocks = mockFs();
const TRACK_PATH = '/mock/profiling';

describe('ProfileBatchProducer', () => {
  beforeEach(() => {
    fsMocks.reset();
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.mkdir.mockResolvedValue(undefined);
    fsMocks.readdir.mockResolvedValue([]);
    fsMocks.writeFile.mockResolvedValue(undefined);
    fsMocks.rename.mockResolvedValue(undefined);
  });

  describe('create()', () => {
    it('creates the track directory when missing', async () => {
      fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

      await ProfileBatchProducer.create(TRACK_PATH);

      expect(fsMocks.mkdir).toHaveBeenCalledWith(TRACK_PATH, { recursive: true });
    });

    it('does not create directory when it already exists', async () => {
      await ProfileBatchProducer.create(TRACK_PATH);

      expect(fsMocks.mkdir).not.toHaveBeenCalled();
    });

    it('rotates orphaned .tmp files from previous sessions', async () => {
      fsMocks.readdir.mockResolvedValueOnce(['profile-111.tmp', 'profile-222.tmp']);

      await ProfileBatchProducer.create(TRACK_PATH);

      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(TRACK_PATH, 'profile-111.tmp'),
        path.join(TRACK_PATH, 'profile-111.log')
      );
      expect(fsMocks.rename).toHaveBeenCalledWith(
        path.join(TRACK_PATH, 'profile-222.tmp'),
        path.join(TRACK_PATH, 'profile-222.log')
      );
    });
  });

  describe('post()', () => {
    it('writes event JSON on line 1 and trace JSON on line 2', async () => {
      const producer = await ProfileBatchProducer.create(TRACK_PATH);
      const event = { application: { id: 'app-1' }, session: { id: 'sess-1' } };
      const trace = { resources: [], frames: [], stacks: [], samples: [] };

      producer.post({ event, trace } as never);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const content = fsMocks.writeFile.mock.calls[0][1] as string;
      const lines = content.split('\n').filter(Boolean);
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0])).toEqual(event);
      expect(JSON.parse(lines[1])).toEqual(trace);
    });

    it('writes to a .tmp file then renames to .log atomically', async () => {
      const producer = await ProfileBatchProducer.create(TRACK_PATH);

      producer.post({ event: {}, trace: {} } as never);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      const tmpPath = path.join(TRACK_PATH, 'profile-1000.tmp');
      const logPath = path.join(TRACK_PATH, 'profile-1000.log');
      expect(fsMocks.writeFile).toHaveBeenCalledWith(tmpPath, expect.any(String), 'utf8');
      expect(fsMocks.rename).toHaveBeenCalledWith(tmpPath, logPath);
    });

    it('serializes concurrent posts without interleaving', async () => {
      const producer = await ProfileBatchProducer.create(TRACK_PATH);

      producer.post({ event: { seq: 1 }, trace: {} } as never);
      producer.post({ event: { seq: 2 }, trace: {} } as never);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));

      expect(fsMocks.writeFile).toHaveBeenCalledTimes(2);
    });
  });
});
