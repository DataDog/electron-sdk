import type { RumEvent as RendererRumEvent } from './rendererRumEvent.types';
import type { RumEvent as MainRumEvent, RumExecutionContextEvent } from './mainRumEvent.types';

export type { RendererRumEvent, MainRumEvent, RumExecutionContextEvent };
export type RumEvent = MainRumEvent | RendererRumEvent;

export * from './rawRumData.types';
// Only rendererRumEvent.types is wildcard-exported: both generated files define same-named
// sub-event types (e.g. RumErrorEvent), so re-exporting mainRumEvent.types too would collide.
// MainRumEvent and RumExecutionContextEvent above are named exports instead, for the main-only
// types that don't have a colliding renderer counterpart.
export * from './rendererRumEvent.types';
