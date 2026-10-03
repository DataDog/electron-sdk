import { afterEach, expect, it, vi } from 'vitest';
import { init } from './index';
import { addError, stopTelemetry } from './domain/telemetry';
import { EventKind, EventTrack, type ServerEvent } from './event';
import { createTestConfiguration } from './mocks.specUtil';

vi.mock('node:fs/promises');
vi.mock('electron', () => ({ app: { getPath: () => '/mock/user/data' } }));
vi.mock('./domain/tracing/Tracing', () => ({ Tracing: vi.fn() }));

const { createBatchManager, post } = vi.hoisted(() => ({
  createBatchManager: vi.fn(),
  post: vi.fn<(event: ServerEvent) => void>(),
}));
vi.mock('./transport/batch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./transport/batch')>()),
  BatchManager: { create: createBatchManager },
  BatchMigration: { clearPendingData: vi.fn().mockResolvedValue(undefined) },
}));

afterEach(() => {
  stopTelemetry();
  vi.restoreAllMocks();
});

it('routes SDK errors while transport initialization is still in progress', async () => {
  const error = new Error('upload failed during initialization');
  createBatchManager.mockImplementation(async (_configuration, { trackType }: { trackType: EventTrack }) => {
    if (trackType === EventTrack.RUM) return { post };
    // The RUM track is ready while a later track is still being initialized.
    await Promise.resolve();
    addError(error);
    throw error;
  });

  await expect(init(createTestConfiguration({ allowedRendererHosts: ['*'] }))).rejects.toBe(error);

  expect(post.mock.calls.map(([event]) => event)).toMatchObject([
    {
      kind: EventKind.SERVER,
      track: EventTrack.RUM,
      data: {
        application: { id: 'test-app-id' },
        source: 'electron',
        telemetry: { status: 'error', message: error.message },
      },
    },
  ]);
});
