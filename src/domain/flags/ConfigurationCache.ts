import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { TimeStamp } from '@datadog/js-core/time';
import { display } from '../../tools/display';

export const CONFIGURATION_CACHE_MAX_AGE = 7 * 24 * 60 * 60 * 1000;

export interface CachedConfiguration {
  wire: string;
  fetchedAt: TimeStamp;
}

export interface ConfigurationCacheOptions {
  userDataPath: string;
  site: string;
  env: string;
  clientToken: string;
  flaggingProxy?: string;
  /** When false, the cache never reads or writes. */
  persistConfiguration: boolean;
}

/**
 * Disk cache of the last valid serialized configuration
 * (`userData/_dd_flags/<sha256 of the environment identity>.json`, D7). Rules do not
 * depend on identity, so scoping by environment avoids cross-identity leakage.
 * Entries older than {@link CONFIGURATION_CACHE_MAX_AGE} are ignored and deleted so a
 * device does not run week-old kill-switch states offline indefinitely.
 *
 * Writes go through a single pending-write chain (like `DiskValueHistory`): concurrent
 * writes are serialized and the last write wins; a write failure keeps the in-memory
 * state and warns.
 */
export class ConfigurationCache {
  private pendingWrite: Promise<void> = Promise.resolve();
  private cached: CachedConfiguration | undefined;

  private constructor(
    readonly filePath: string,
    private readonly persistConfiguration: boolean
  ) {}

  static async init(options: ConfigurationCacheOptions): Promise<ConfigurationCache> {
    const identity = `${options.site}|${options.env}|${options.clientToken}|${options.flaggingProxy ?? ''}`;
    const fileName = `${createHash('sha256').update(identity).digest('hex')}.json`;
    const cache = new ConfigurationCache(`${options.userDataPath}/_dd_flags/${fileName}`, options.persistConfiguration);
    if (!options.persistConfiguration) {
      return cache;
    }
    let content: string;
    try {
      content = await fs.readFile(cache.filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        display.warn('Cannot read the feature flags configuration cache; starting without it.');
      }
      return cache;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch {
      display.warn('Ignoring a corrupt feature flags configuration cache entry.');
      return cache;
    }
    if (!isCachedConfiguration(parsed)) {
      display.warn('Ignoring a corrupt feature flags configuration cache entry.');
      return cache;
    }
    if (Date.now() - parsed.fetchedAt > CONFIGURATION_CACHE_MAX_AGE) {
      cache.cached = undefined;
      void Promise.resolve(fs.unlink(cache.filePath)).catch(() => undefined);
      return cache;
    }
    cache.cached = parsed;
    return cache;
  }

  /** The cached entry, or `undefined` when none is held. */
  entry(): CachedConfiguration | undefined {
    return this.cached;
  }

  /** Persist a configuration. Writes are serialized; the last write wins. */
  write(wire: string, fetchedAt: TimeStamp): Promise<void> {
    this.cached = { wire, fetchedAt };
    if (!this.persistConfiguration) {
      return this.pendingWrite;
    }
    this.pendingWrite = this.pendingWrite.then(() =>
      fs
        .writeFile(this.filePath, JSON.stringify({ wire, fetchedAt }), 'utf-8')
        .catch(() => {
          display.warn('Cannot persist the feature flags configuration cache; the in-memory configuration is kept.');
        })
        .then(() => undefined)
    );
    return this.pendingWrite;
  }

  /** Resolves once the pending write, if any, has settled. */
  idle(): Promise<void> {
    return this.pendingWrite;
  }
}

function isCachedConfiguration(value: unknown): value is CachedConfiguration {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as CachedConfiguration).wire === 'string' &&
    typeof (value as CachedConfiguration).fetchedAt === 'number'
  );
}
