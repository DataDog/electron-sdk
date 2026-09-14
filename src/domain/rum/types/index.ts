import type { RumEvent as RendererRumEvent } from './rendererRumEvent.types';
import type { RumEvent as MainRumEvent } from './mainRumEvent.types';

export type { RendererRumEvent, MainRumEvent };
export type RumEvent = MainRumEvent | RendererRumEvent;

export * from './rawRumData.types';
// Only rendererRumEvent.types is wildcard-exported: both generated files define same-named
// sub-event types (e.g. RumErrorEvent), so re-exporting mainRumEvent.types too would collide.
// MainRumEvent above is the supported entry point for main-process schema types.
export * from './rendererRumEvent.types';
