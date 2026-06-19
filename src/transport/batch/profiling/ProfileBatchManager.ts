import { setTimeout } from '@datadog/browser-core';
import path from 'node:path';
import type { Configuration } from '../../../config';
import { EventTrack } from '../../../event';
import { addError } from '../../../domain/telemetry';
import { computeIntakeUrlForTrack } from '../../utils';
import { ProfileBatchProducer } from './ProfileBatchProducer';
import { ProfileBatchConsumer } from './ProfileBatchConsumer';
import type { ProfileData } from './ProfileBatchProducer';

interface ProfileBatchManagerConfig {
  path: string;
  uploadFrequency: number;
}

export class ProfileBatchManager {
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  private isUploading = false;

  private constructor(
    private readonly producer: ProfileBatchProducer,
    private readonly consumer: ProfileBatchConsumer,
    private readonly uploadFrequency: number
  ) {}

  static async create(config: Configuration, managerConfig: ProfileBatchManagerConfig): Promise<ProfileBatchManager> {
    const trackPath = path.join(managerConfig.path, EventTrack.PROFILE);
    const intakeUrl = computeIntakeUrlForTrack(config.site, EventTrack.PROFILE, { proxy: config.proxy });

    const producer = await ProfileBatchProducer.create(trackPath);
    const consumer = new ProfileBatchConsumer({ trackPath, intakeUrl, clientToken: config.clientToken });

    const manager = new ProfileBatchManager(producer, consumer, managerConfig.uploadFrequency);
    manager.start();
    return manager;
  }

  post(data: ProfileData): void {
    this.producer.post(data);
  }

  async flush(): Promise<void> {
    await this.triggerUploadCycle();
  }

  stop(): void {
    if (this.timeoutId !== null) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }
  }

  private start(): void {
    this.scheduleNext();
  }

  private scheduleNext(): void {
    this.timeoutId = setTimeout(() => {
      void this.triggerUploadCycle()
        .catch((err) => addError(err))
        .then(() => this.scheduleNext());
    }, this.uploadFrequency);
  }

  private async triggerUploadCycle(): Promise<void> {
    if (this.isUploading) return;
    this.isUploading = true;
    try {
      await this.consumer.upload();
    } finally {
      this.isUploading = false;
    }
  }
}
