import type { Event, EventHandler } from './event.types';

/**
 * Manages event routing through registered handlers.
 * Handlers are invoked in registration order for each event they can handle.
 */
export class EventManager {
  private handlers: EventHandler<Event>[] = [];

  /**
   * Registers a handler to process events.
   * The handler's canHandle type guard ensures type safety at runtime.
   */
  registerHandler<T extends Event>(handler: EventHandler<T>) {
    // Store as EventHandler<Event> - the type guard ensures safety at runtime
    this.handlers.push(handler as unknown as EventHandler<Event>);
    return {
      unsubscribe: () => this.removeHandler<T>(handler),
    };
  }

  /**
   * Unregisters a handler.
   */
  removeHandler<T extends Event>(handler: EventHandler<T>) {
    this.handlers = this.handlers.filter((h) => h !== (handler as unknown as EventHandler<Event>));
  }

  /**
   * Dispatches events to all registered handlers.
   * Each handler can emit new events via the notify callback.
   */
  notify(data: Event | Event[]) {
    const events = Array.isArray(data) ? data : [data];
    const notifyFn: (data: Event | Event[]) => void = (e) => this.notify(e);

    for (const event of events) {
      for (const handler of this.handlers) {
        if (!handler.canHandle(event)) {
          continue;
        }
        // After canHandle returns true, TypeScript knows event matches the handler's type
        handler.handle(event, notifyFn);
      }
    }
  }
}
