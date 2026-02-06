import type { Event, EventHandler } from './types';

/**
 * Manages event routing through registered handlers.
 * Handlers are invoked in registration order for each event they can handle.
 */
export class EventManager<T extends Event> {
  private handlers: EventHandler<T>[] = [];

  /**
   * Registers a handler to process events.
   */
  registerHandler(handler: EventHandler<T>) {
    this.handlers.push(handler);
  }

  /**
   * Dispatches events to all registered handlers.
   * Each handler can emit new events via the notify callback.
   */
  notify(data: T | T[]) {
    const events = Array.isArray(data) ? data : [data];

    for (const event of events) {
      for (const handler of this.handlers) {
        if (!handler.canHandle(event)) {
          continue;
        }

        handler.handle(event, (e) => this.notify(e));
      }
    }
  }
}
