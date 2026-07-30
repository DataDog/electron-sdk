import type { App, Event } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BeforeQuitHandler } from './BeforeQuitHandler';

describe('BeforeQuitHandler', () => {
  let app: App;
  let listener: ((event: Event) => void) | undefined;
  let removeListener: ReturnType<typeof vi.fn>;
  let quit: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    removeListener = vi.fn((_eventName: string, registeredListener: (event: Event) => void) => {
      if (listener === registeredListener) {
        listener = undefined;
      }
    });
    quit = vi.fn();
    const fakeApp = {
      on: vi.fn((_eventName: string, registeredListener: (event: Event) => void) => {
        listener = registeredListener;
      }),
      removeListener,
      quit,
    };
    app = fakeApp as unknown as App;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('prevents shutdown until the flush completes', async () => {
    const flush = vi.fn().mockResolvedValue(undefined);
    const handler = new BeforeQuitHandler(app, flush);
    const event = { preventDefault: vi.fn() } as unknown as Event;

    handler.start();
    listener!(event);
    await Promise.resolve();

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledOnce();
    expect(removeListener).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(quit).toHaveBeenCalledOnce();
  });

  it('does not start another flush when quit is requested again', () => {
    const flush = vi.fn(() => new Promise<void>(() => undefined));
    const handler = new BeforeQuitHandler(app, flush);
    const event = { preventDefault: vi.fn() } as unknown as Event;

    handler.start();
    listener!(event);
    listener!(event);

    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();
  });

  it('quits after the fallback timeout when the flush does not complete', () => {
    const flush = vi.fn(() => new Promise<void>(() => undefined));
    const handler = new BeforeQuitHandler(app, flush);
    const event = { preventDefault: vi.fn() } as unknown as Event;

    handler.start();
    listener!(event);
    vi.advanceTimersByTime(5_000);

    expect(removeListener).toHaveBeenCalledWith('before-quit', expect.any(Function));
    expect(quit).toHaveBeenCalledOnce();
  });
});
