import { describe, expect, it, vi } from 'vitest';
import type { ServerEvent } from '../../event';
import type { BatchProducer } from './BatchProducer';
import { PendingBatchStore } from './PendingBatchStore';

vi.mock('../../domain/telemetry', () => ({ monitor: <T>(callback: T): T => callback }));
vi.mock('../../tools/display', () => ({ display: { error: vi.fn() } }));

const event = { data: { value: 'accepted' } } as unknown as ServerEvent;

function createProducer() {
  const post = vi.fn<BatchProducer['post']>();
  const flush = vi.fn<BatchProducer['flush']>().mockResolvedValue(undefined);
  return { post, flush, producer: { post, flush } as unknown as BatchProducer };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

describe('PendingBatchStore', () => {
  it('drains posts accepted before closure when creation finishes afterwards', async () => {
    const creation = deferred<BatchProducer>();
    const { producer, post, flush } = createProducer();
    const store = new PendingBatchStore('/data/rum', () => creation.promise);

    store.post(event);
    store.close();
    store.post(event);
    const sealing = store.flush();
    creation.resolve(producer);
    await sealing;

    expect(post).toHaveBeenCalledExactlyOnceWith(event);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[0]);
  });

  it('shares an in-flight creation retry with concurrent flushes and drains it after closure', async () => {
    const retry = deferred<BatchProducer>();
    const { producer, post } = createProducer();
    const factory = vi
      .fn<(directory: string) => Promise<BatchProducer>>()
      .mockRejectedValueOnce(new Error('directory unavailable'))
      .mockReturnValue(retry.promise);
    const store = new PendingBatchStore('/data/rum', factory);

    const firstFlush = store.flush();
    const secondFlush = store.flush();
    await vi.waitFor(() => expect(factory).toHaveBeenCalledTimes(2));
    store.post(event);
    store.close();
    const finalFlush = store.flush();
    retry.resolve(producer);
    await Promise.all([firstFlush, secondFlush, finalFlush]);

    expect(factory).toHaveBeenCalledTimes(2);
    expect(post).toHaveBeenCalledExactlyOnceWith(event);
  });

  it('does not start a queued creation retry once the period is closed', async () => {
    const factory = vi.fn().mockRejectedValue(new Error('directory unavailable'));
    const store = new PendingBatchStore('/data/rum', factory);

    const flushing = store.flush();
    store.close();
    await flushing;

    expect(factory).toHaveBeenCalledOnce();
  });

  it('seals again after later accepted posts instead of reusing an earlier flush', async () => {
    const firstSeal = deferred<void>();
    const { producer, post, flush } = createProducer();
    flush.mockReturnValueOnce(firstSeal.promise);
    const store = new PendingBatchStore('/data/rum', () => Promise.resolve(producer));
    const firstFlush = store.flush();
    await vi.waitFor(() => expect(flush).toHaveBeenCalledOnce());

    store.post(event);
    store.close();
    await store.flush();
    firstSeal.resolve(undefined);
    await firstFlush;

    expect(flush).toHaveBeenCalledTimes(2);
    expect(post.mock.invocationCallOrder[0]).toBeLessThan(flush.mock.invocationCallOrder[1]);
  });
});
