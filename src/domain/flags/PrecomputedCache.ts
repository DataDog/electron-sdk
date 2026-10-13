import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { TimeStamp } from '@datadog/js-core/time';
import { configurationFromString } from '@datadog/openfeature-browser/rules-based';
import { timeStampNow } from '@datadog/js-core/time';
import { display } from '../../tools/display';
import { callMonitored } from '../telemetry';
import { CONFIGURATION_CACHE_MAX_AGE } from './ConfigurationCache';
import { MAX_CONFIGURATION_LENGTH } from './RulesFetcher';
import type { FlatContext } from '../../common/flags/types';

export const PRECOMPUTED_CACHE_MAX_CONTEXTS = 5;

export interface CachedPrecomputedEntry {
  wire: string;
  fetchedAt: TimeStamp;
}

interface IndexEntry {
  key: string;
  fetchedAt: TimeStamp;
  lastUsed: TimeStamp;
}

interface MemoryEntry extends IndexEntry {
  wire: string;
}

export interface PrecomputedCacheOptions {
  userDataPath: string;
  site: string;
  env: string;
  clientToken: string;
  flaggingProxy?: string;
  applicationId?: string;
  /** When false, the cache never reads or writes. */
  persistConfiguration: boolean;
  /** Entries whose wire exceeds this length are ignored (defaults to MAX_CONFIGURATION_LENGTH, D15). */
  maxConfigurationLength?: number;
}

/**
 * Per-context disk cache of precomputed assignments
 * (`userData/_dd_flags/precomputed/<sha256 of the environment identity and the
 * canonical context>.json`, M7/D28). Unlike rules, assignments are identity-specific,
 * so the key includes the evaluation context — whose targeting attributes are stored
 * at rest, like the browser SDK's IndexedDB cache. At most
 * {@link PRECOMPUTED_CACHE_MAX_CONTEXTS} contexts are kept (least recently used first)
 * and entries older than {@link CONFIGURATION_CACHE_MAX_AGE} are ignored and deleted.
 *
 * Writes go through a single pending-write chain: concurrent writes are serialized and
 * the last write wins; a write failure keeps the in-memory state and warns.
 */
export class PrecomputedCache {
  private pendingWrite: Promise<void> = Promise.resolve();
  /** LRU order: least recently used first. */
  private entries: MemoryEntry[] = [];

  private constructor(
    private readonly directory: string,
    private readonly identity: string,
    private readonly persistConfiguration: boolean,
    private readonly maxConfigurationLength: number
  ) {}

  static async init(options: PrecomputedCacheOptions): Promise<PrecomputedCache> {
    const identity = `${options.site}|${options.env}|${options.clientToken}|${options.flaggingProxy ?? ''}|${options.applicationId ?? ''}`;
    const cache = new PrecomputedCache(
      `${options.userDataPath}/_dd_flags/precomputed`,
      identity,
      options.persistConfiguration,
      options.maxConfigurationLength ?? MAX_CONFIGURATION_LENGTH
    );
    if (!options.persistConfiguration) {
      return cache;
    }
    let indexContent: string;
    try {
      indexContent = await fs.readFile(cache.indexFilePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        display.warn('Cannot read the feature flags assignments cache; starting without it.');
      }
      return cache;
    }
    let index: unknown;
    try {
      index = JSON.parse(indexContent);
    } catch {
      display.warn('Ignoring a corrupt feature flags assignments cache.');
      return cache;
    }
    if (!isIndex(index)) {
      display.warn('Ignoring a corrupt feature flags assignments cache.');
      return cache;
    }
    const now = Date.now();
    const valid: MemoryEntry[] = [];
    const expired: IndexEntry[] = [];
    // Oldest use first so the LRU bound is applied by dropping from the front.
    const sorted = [...index.entries].sort((a, b) => a.lastUsed - b.lastUsed);
    for (const entry of sorted) {
      if (now - entry.fetchedAt > CONFIGURATION_CACHE_MAX_AGE) {
        expired.push(entry);
        continue;
      }
      let content: string;
      try {
        content = await fs.readFile(cache.entryFilePath(entry.key), 'utf-8');
      } catch {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        display.warn('Ignoring a corrupt feature flags assignments cache entry.');
        continue;
      }
      if (!isCachedPrecomputedEntry(parsed, cache.maxConfigurationLength)) {
        display.warn('Ignoring a corrupt feature flags assignments cache entry.');
        continue;
      }
      valid.push({ ...entry, wire: parsed.wire });
    }
    cache.entries = valid.slice(Math.max(0, valid.length - PRECOMPUTED_CACHE_MAX_CONTEXTS));
    const dropped = [...expired, ...valid.slice(0, Math.max(0, valid.length - PRECOMPUTED_CACHE_MAX_CONTEXTS))];
    for (const entry of dropped) {
      const key = entry.key;
      cache.enqueue(() => fs.unlink(cache.entryFilePath(key)));
    }
    if (dropped.length > 0) {
      cache.enqueue(() => cache.writeIndex());
    }
    return cache;
  }

  /** The cache key for a context: the environment identity plus the canonical context. */
  keyFor(context: FlatContext): string {
    return precomputedCacheKey(this.identity, context);
  }

  /**
   * The cached assignments for a context, or `undefined`. A hit refreshes the entry's
   * recency (LRU).
   */
  entry(context: FlatContext): CachedPrecomputedEntry | undefined {
    const key = this.keyFor(context);
    const index = this.entries.findIndex((entry) => entry.key === key);
    if (index === -1) {
      return undefined;
    }
    const [hit] = this.entries.splice(index, 1);
    // Re-check the age: an entry that aged out since startup is not served (D7).
    if (timeStampNow() - hit.fetchedAt > CONFIGURATION_CACHE_MAX_AGE) {
      if (this.persistConfiguration) {
        this.enqueue(async () => {
          await fs.unlink(this.entryFilePath(key)).catch(() => undefined);
          await this.writeIndex();
        });
      }
      return undefined;
    }
    // A hit refreshes the entry's recency and persists it, so a recently read context
    // survives LRU eviction across a restart.
    const refreshed = { ...hit, lastUsed: timeStampNow() };
    this.entries.push(refreshed);
    if (this.persistConfiguration) {
      this.enqueue(() => this.writeIndex());
    }
    return { wire: hit.wire, fetchedAt: hit.fetchedAt };
  }

  /** Persist assignments for a context. Writes are serialized; the last write wins. */
  write(context: FlatContext, wire: string, fetchedAt: TimeStamp): Promise<void> {
    const key = this.keyFor(context);
    const lastUsed = timeStampNow();
    this.entries = this.entries.filter((entry) => entry.key !== key);
    this.entries.push({ key, wire, fetchedAt, lastUsed });
    const evicted = this.entries.slice(0, Math.max(0, this.entries.length - PRECOMPUTED_CACHE_MAX_CONTEXTS));
    this.entries = this.entries.slice(Math.max(0, this.entries.length - PRECOMPUTED_CACHE_MAX_CONTEXTS));
    if (!this.persistConfiguration) {
      return this.pendingWrite;
    }
    this.enqueue(async () => {
      for (const entry of evicted) {
        await fs.unlink(this.entryFilePath(entry.key)).catch(() => undefined);
      }
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(this.entryFilePath(key), JSON.stringify({ wire, fetchedAt }), 'utf-8');
      await this.writeIndex();
    });
    return this.pendingWrite;
  }

  /** Resolves once the pending write, if any, has settled. */
  idle(): Promise<void> {
    return this.pendingWrite;
  }

  private get indexFilePath(): string {
    return path.join(this.directory, 'index.json');
  }

  private entryFilePath(key: string): string {
    return path.join(this.directory, `${key}.json`);
  }

  private async writeIndex(): Promise<void> {
    await fs.writeFile(
      this.indexFilePath,
      JSON.stringify({
        entries: this.entries.map(({ key, fetchedAt, lastUsed }) => ({ key, fetchedAt, lastUsed })),
      }),
      'utf-8'
    );
  }

  /**
   * Append a disk operation to the single pending-write chain. Operations run one after
   * the other; a failing operation warns and never breaks the chain. Both callbacks are
   * monitored, so an SDK error reaches telemetry instead of rejecting.
   */
  private enqueue(operation: () => Promise<unknown>): void {
    this.pendingWrite = this.pendingWrite.then(() =>
      Promise.resolve(callMonitored(operation)).then(
        () => undefined,
        () => {
          callMonitored(() => {
            display.warn('Cannot persist the feature flags assignments cache; the in-memory assignments are kept.');
          });
        }
      )
    );
  }
}

/** The disk-cache key for a context: the environment identity plus the canonical context. */
export function precomputedCacheKey(identity: string, context: FlatContext): string {
  return createHash('sha256')
    .update(`${identity}|${canonicalContext(context)}`)
    .digest('hex');
}

/** A stable serialization of a flat context (its values are primitives). */
function canonicalContext(context: FlatContext): string {
  const keys = Object.keys(context).sort();
  return JSON.stringify(keys.map((key) => [key, context[key]]));
}

function isIndex(value: unknown): value is { entries: IndexEntry[] } {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { entries?: unknown }).entries)) {
    return false;
  }
  return (value as { entries: unknown[] }).entries.every(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as IndexEntry).key === 'string' &&
      isFiniteNumber((entry as IndexEntry).fetchedAt) &&
      isFiniteNumber((entry as IndexEntry).lastUsed)
  );
}

function isCachedPrecomputedEntry(value: unknown, maxConfigurationLength: number): value is CachedPrecomputedEntry {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { wire, fetchedAt } = value as Partial<CachedPrecomputedEntry>;
  if (typeof wire !== 'string' || typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt)) {
    return false;
  }
  if (wire.length > maxConfigurationLength) {
    return false;
  }
  try {
    return configurationFromString(wire).precomputed !== undefined;
  } catch {
    return false;
  }
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}
