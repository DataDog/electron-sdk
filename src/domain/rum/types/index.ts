import type { RumEvent as RendererRumEvent } from './rendererRumEvent.types';
import type {
  RumEvent as GeneratedMainRumEvent,
  RumExecutionContextEvent as GeneratedRumExecutionContextEvent,
} from './mainRumEvent.types';

type WithMandatory<T, K extends keyof T> = T & { [P in K]-?: T[P] };

// TODO: remove once execution-context is no longer optional to allow the breaking change in types
export type RumExecutionContextEvent = WithMandatory<GeneratedRumExecutionContextEvent, 'view'>;

export type MainRumEvent = Exclude<GeneratedMainRumEvent, { type: 'execution_context' }> | RumExecutionContextEvent;

export type { RendererRumEvent };
export type RumEvent = MainRumEvent | RendererRumEvent;

export * from './rawRumData.types';
// Only rendererRumEvent.types is wildcard-exported: both generated files define same-named
// sub-event types (e.g. RumErrorEvent), so re-exporting mainRumEvent.types too would collide.
// MainRumEvent and RumExecutionContextEvent above are named exports instead, for the main-only
// types that don't have a colliding renderer counterpart.
export * from './rendererRumEvent.types';
