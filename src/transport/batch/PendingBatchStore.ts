import { generateUUID } from '@datadog/browser-core';
import path from 'node:path';
import { monitor } from '../../domain/telemetry';
import type { ServerEvent } from '../../event';
import { display } from '../../tools/display';
import type { BatchProducer } from './BatchProducer';
import { PENDING_DIRECTORY_PREFIX } from './batchPaths';

/** Owns one pending period's directory and writer, including asynchronous creation and retries. */
export class PendingBatchStore {
  readonly path: string;
  private producer: Promise<BatchProducer | undefined>;
  private closed = false;

  constructor(
    trackPath: string,
    private readonly createProducer: (directory: string) => Promise<BatchProducer>
  ) {
    this.path = path.join(trackPath, `${PENDING_DIRECTORY_PREFIX}${generateUUID()}`);
    this.producer = this.initializeProducer();
  }

  post(event: ServerEvent): void {
    if (this.closed) return;
    // Posts accepted before close still drain, even if directory creation finishes afterwards.
    void this.producer.then(monitor((producer: BatchProducer | undefined) => producer?.post(event)));
  }

  /** Ends the period: no new events or creation retries may race with its migration. */
  close(): void {
    this.closed = true;
  }

  async flush(): Promise<void> {
    // Share any creation retry with later posts and flushes, including a migration's final flush.
    this.producer = this.producer.then(
      monitor(
        (producer: BatchProducer | undefined) => producer ?? (this.closed ? undefined : this.initializeProducer())
      )
    );
    const producer = await this.producer;
    await producer?.flush();
  }

  private initializeProducer(): Promise<BatchProducer | undefined> {
    return this.createProducer(this.path).catch(
      monitor((error) => {
        display.error('Failed to create pending batch storage', error);
        return undefined;
      })
    );
  }
}
