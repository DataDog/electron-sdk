export const EventSource = {
  RENDERER: 'renderer',
  MAIN: 'main-process',
} as const;

export const EventTrack = {
  LOGS: 'logs',
  RUM: 'rum',
  SPANS: 'spans',
} as const;

export const EventFormat = {
  RUM: 'rum',
  TELEMETRY: 'telemetry',
} as const;

export const EventKind = {
  RAW: 'raw',
  SERVER: 'server',
  LIFECYCLE: 'lifecycle',
} as const;

export const LifecycleKind = {
  END_USER_ACTIVITY: 'end_user_activity',
  SESSION_EXPIRED: 'session_expired',
  SESSION_RENEW: 'session_renew',
} as const;
