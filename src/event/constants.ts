export const EventSource = {
  RENDERER: 'renderer',
  MAIN: 'main-process',
} as const;

export const EventTrack = {
  LOGS: 'logs',
  RUM: 'rum',
  SPANS: 'spans',
} as const;

export const EventKind = {
  RAW: 'raw',
  SERVER: 'server',
  LIFECYCLE: 'lifecyle',
} as const;

export const LifecycleKind = {
  END_USER_ACTIVITY: 'end_user_activity',
} as const;
