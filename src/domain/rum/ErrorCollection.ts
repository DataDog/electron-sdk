import { EventManager } from '../../event';

export class ErrorCollection {
  // @ts-expect-error implemented later
  constructor(private readonly eventManager: EventManager) {}

  stop(): void {
    /* implemented later */
  }
}
