/**
 * Feature flags in spawned processes (`child_process.fork`, `utilityProcess`,
 * `worker_threads`). Import from `@datadog/electron-sdk/child` in the child; open the
 * channel in main with `openFlagsChannel` from `@datadog/electron-sdk`. Nothing here
 * imports `electron`.
 */
export { connectFlags, ChildFlagsClient, CONTEXT_REQUEST_TIMEOUT } from '../child/flags/ChildFlagsClient';
export type {
  ChildFlagDetails,
  ContextUpdateResult,
  FlagsChangeEvent,
  FlagsFramesSender,
} from '../child/flags/ChildFlagsClient';
export type { FlagsPortLike } from '../child/flags/childEndpoints';
export type { FlagsStatus } from '../common/flags/types';
