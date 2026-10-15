import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TimeStamp } from '@datadog/js-core/time';
import { configurationFromString } from '@datadog/openfeature-browser/rules-based';
import { display } from '../../tools/display';
import { callMonitored } from '../telemetry';
import { MAX_CONFIGURATION_LENGTH } from './RulesFetcher';

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
  /** Entries whose wire exceeds this length are ignored (defaults to MAX_CONFIGURATION_LENGTH, D15). */
  maxConfigurationLength?: number;
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
    if (!isCachedConfiguration(parsed, options.maxConfigurationLength ?? MAX_CONFIGURATION_LENGTH)) {
      display.warn('Ignoring a corrupt feature flags configuration cache entry.');
      return cache;
    }
    if (Date.now() - parsed.fetchedAt > CONFIGURATION_CACHE_MAX_AGE) {
      // Deleting goes through the write chain so a later write can never be removed by it.
      cache.enqueue(() => fs.unlink(cache.filePath));
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
    this.enqueue(
      async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, JSON.stringify({ wire, fetchedAt }), 'utf-8');
      },
      () => {
        display.warn('Cannot persist the feature flags configuration cache; the in-memory configuration is kept.');
      }
    );
    return this.pendingWrite;
  }

  /**
   * Append a disk operation to the single pending-write chain. Operations run one after
   * the other; a failing operation runs `onFailure` and never breaks the chain. Both
   * callbacks are monitored, so an SDK error reaches telemetry instead of rejecting.
   */
  private enqueue(operation: () => Promise<unknown>, onFailure: () => void = () => undefined): void {
    this.pendingWrite = this.pendingWrite.then(() =>
      Promise.resolve(callMonitored(operation)).then(
        () => undefined,
        () => {
          callMonitored(onFailure);
        }
      )
    );
  }

  /** Resolves once the pending write, if any, has settled. */
  idle(): Promise<void> {
    return this.pendingWrite;
  }
}

/**
 * A cache entry is usable only when its wire is within the size limit and parses to an
 * evaluable rules configuration, and its `fetchedAt` is a finite timestamp (S4).
 */
function isCachedConfiguration(value: unknown, maxConfigurationLength: number): value is CachedConfiguration {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { wire, fetchedAt } = value as Partial<CachedConfiguration>;
  if (typeof wire !== 'string' || typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
    return false;
  }
  if (wire.length > maxConfigurationLength) {
    return false;
  }
  try {
    return configurationFromString(wire).rules !== undefined;
  } catch {
    return false;
  }
}
