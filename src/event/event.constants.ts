export const EventSource = {
  RENDERER: 'renderer',
  MAIN: 'main-process',
} as const;
export type EventSource = (typeof EventSource)[keyof typeof EventSource];

export const EventTrack = {
  LOGS: 'logs',
  RUM: 'rum',
  SPANS: 'spans',
  PROFILE: 'profile',
  REPLAY: 'replay',
} as const;
export type EventTrack = (typeof EventTrack)[keyof typeof EventTrack];

export const EventFormat = {
  RUM: 'rum',
  TELEMETRY: 'telemetry',
  PROFILE: 'profile',
  REPLAY: 'replay',
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
