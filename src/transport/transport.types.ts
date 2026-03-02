import type { EventTrack } from '../event';

export type TrackType = (typeof EventTrack)[keyof typeof EventTrack];

export interface Domain {
  readonly trackType: TrackType;
  init(): void;
}

export interface BatchManagerConfig {
  path: string;
  trackType: TrackType;
  batchSize: number;
  uploadFrequency: number;
}

export interface ProducerConfig {
  trackPath: string;
  batchSize: number;
}

export interface ConsumerConfig {
  trackPath: string;
  intakeUrl: string;
  clientToken: string;
}
