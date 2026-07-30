import type { App, Event } from 'electron';
import { monitor, setTimeout } from '../domain/telemetry';

const QUIT_FLUSH_TIMEOUT = 5_000;

/**
 * Delays Electron shutdown while pending SDK data is flushed, with a bounded fallback
 * so an unsuccessful flush cannot prevent the application from quitting indefinitely.
 */
export class BeforeQuitHandler {
  private isQuitting = false;
  private readonly handler: (event: Event) => void;

  constructor(
    private readonly app: App,
    private readonly flush: () => Promise<void>
  ) {
    this.handler = monitor((event: Event) => {
      this.onBeforeQuit(event);
    });
  }

  /** Starts intercepting Electron's `before-quit` event. */
  start(): void {
    this.app.on('before-quit', this.handler);
  }

  /** Stops intercepting Electron's `before-quit` event. */
  stop(): void {
    this.app.removeListener('before-quit', this.handler);
  }

  private onBeforeQuit(event: Event): void {
    event.preventDefault();

    if (this.isQuitting) {
      return;
    }
    this.isQuitting = true;

    let done = false;
    const quit = monitor(() => {
      if (done) {
        return;
      }
      done = true;
      this.stop();
      this.app.quit();
    });

    setTimeout(quit, QUIT_FLUSH_TIMEOUT);
    void this.flush().finally(quit);
  }
}
