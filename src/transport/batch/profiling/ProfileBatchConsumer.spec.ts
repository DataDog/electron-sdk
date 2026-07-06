import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'node:path';
import { ProfileBatchConsumer } from './ProfileBatchConsumer';
import { mockFs } from '../../../mocks.specUtil';
import { getUserAgent } from '../../userAgent';
import { display } from '../../../tools/display';

vi.mock('node:fs/promises');
vi.mock('../../userAgent');
vi.mock('../../../tools/display', () => ({
  display: { warn: vi.fn(), error: vi.fn() },
}));
vi.mock('node:zlib', () => ({
  default: {
    deflate: vi.fn((_buf: Buffer, cb: (err: Error | null, result?: Buffer) => void) =>
      cb(null, Buffer.from('compressed'))
    ),
  },
}));

const fsMocks = mockFs();
const TRACK_PATH = '/mock/profiling';
const INTAKE_URL = 'https://browser-intake-datadoghq.com/api/v2/profile';
const CLIENT_TOKEN = 'test-token';
const TEST_USER_AGENT = 'TestApp/1.0 Electron/0';

const eventJson = JSON.stringify({ application: { id: 'app-1' }, session: { id: 'sess-1' } });
const traceJson = JSON.stringify({ resources: [], frames: [], stacks: [], samples: [] });
const twoLineContent = `${eventJson}\n${traceJson}\n`;

describe('ProfileBatchConsumer', () => {
  let consumer: ProfileBatchConsumer;

  beforeEach(() => {
    fsMocks.reset();
    vi.mocked(display.warn).mockClear();
    vi.mocked(getUserAgent).mockReturnValue(TEST_USER_AGENT);
    fsMocks.access.mockResolvedValue(undefined);
    fsMocks.unlink.mockResolvedValue(undefined);
    global.fetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    consumer = new ProfileBatchConsumer({ trackPath: TRACK_PATH, intakeUrl: INTAKE_URL, clientToken: CLIENT_TOKEN });
  });

  describe('upload()', () => {
    it('reads .log files only', async () => {
      fsMocks.readdir.mockResolvedValue(['a.log', 'b.tmp']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(fsMocks.readFile).toHaveBeenCalledWith(path.join(TRACK_PATH, 'a.log'), 'utf8');
    });

    it('posts to the intake URL with the standard SDK headers', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      expect(request.url).toBe(INTAKE_URL);
      expect(request.headers.get('DD-API-KEY')).toBe(CLIENT_TOKEN);
      expect(request.headers.get('DD-EVP-ORIGIN')).toBe('electron');
      expect(request.headers.get('DD-EVP-ORIGIN-VERSION')).toBe('test');
      expect(request.headers.get('DD-REQUEST-ID')).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      expect(request.headers.get('User-Agent')).toBe(TEST_USER_AGENT);
    });

    it('sends a FormData body with event and wall-time.json parts', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      const [request] = vi.mocked(fetch).mock.calls[0] as [Request];
      const body = await request.formData();
      expect(body).toBeInstanceOf(FormData);

      const eventPart = body.get('event') as File;
      expect(eventPart.name).toBe('event.json');
      expect(eventPart.type).toBe('application/json');
      const eventText = await eventPart.text();
      expect(JSON.parse(eventText)).toEqual(JSON.parse(eventJson));

      const tracePart = body.get('wall-time.json') as File;
      expect(tracePart.name).toBe('wall-time.json');
    });

    it('deflate-compresses the trace before sending', async () => {
      const zlib = await import('node:zlib');
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      expect(zlib.default.deflate).toHaveBeenCalledWith(Buffer.from(traceJson), expect.any(Function));
    });

    it('deletes file on HTTP 2xx', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      expect(fsMocks.unlink).toHaveBeenCalledWith(path.join(TRACK_PATH, 'profile.log'));
    });

    it('keeps file on HTTP failure for retry', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);
      vi.mocked(fetch).mockResolvedValueOnce({ ok: false, status: 500 } as Response);

      await consumer.upload();

      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });

    it('drops, warns, and deletes files with fewer than 2 lines', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue('only one line\n');

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledTimes(1);
      expect(display.warn).toHaveBeenCalled();
    });

    it('drops, warns, and deletes the file when trace compression fails', async () => {
      const zlib = await import('node:zlib');
      vi.mocked(zlib.default.deflate).mockImplementationOnce(((_buf: Buffer, cb: (err: Error | null) => void) =>
        cb(new Error('deflate boom'))) as unknown as typeof zlib.default.deflate);
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);

      await consumer.upload();

      expect(fetch).not.toHaveBeenCalled();
      expect(fsMocks.unlink).toHaveBeenCalledWith(path.join(TRACK_PATH, 'profile.log'));
      expect(display.warn).toHaveBeenCalled();
    });

    it('handles missing trackPath gracefully', async () => {
      fsMocks.access.mockRejectedValueOnce(new Error('ENOENT'));

      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fetch).not.toHaveBeenCalled();
    });

    it('handles network errors without throwing', async () => {
      fsMocks.readdir.mockResolvedValue(['profile.log']);
      fsMocks.readFile.mockResolvedValue(twoLineContent);
      vi.mocked(fetch).mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(consumer.upload()).resolves.not.toThrow();
      expect(fsMocks.unlink).not.toHaveBeenCalled();
    });
  });
});
