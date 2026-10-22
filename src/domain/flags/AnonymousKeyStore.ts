import * as fs from 'node:fs/promises';
import { generateUUID } from '@datadog/browser-core';
import { display } from '../../tools/display';

const ANONYMOUS_KEY_FILE = '_dd_flags_anonymous_key';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Persistent per-install anonymous targeting key (`userData/_dd_flags_anonymous_key`).
 * Used whenever the flag context has no valid targeting key, so percentage rollouts
 * stay stable across restarts. Write failures keep an in-memory key: evaluation still
 * works, only the bucket stability across restarts is lost.
 */
export class AnonymousKeyStore {
  private constructor(readonly anonymousKey: string) {}

  static async init(userDataPath: string): Promise<AnonymousKeyStore> {
    const filePath = `${userDataPath}/${ANONYMOUS_KEY_FILE}`;
    let persisted: string | undefined;
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      if (UUID_PATTERN.test(content)) {
        persisted = content;
      }
    } catch {
      // No key yet, or unreadable: regenerate below. A read failure on an existing key
      // file means a new bucket, so surface it.
      display.warn('Cannot read the feature flags anonymous key; a new key is generated.');
    }
    if (persisted !== undefined) {
      return new AnonymousKeyStore(persisted);
    }
    const anonymousKey = generateUUID();
    try {
      await fs.writeFile(filePath, anonymousKey, 'utf-8');
    } catch {
      display.warn('Cannot persist the feature flags anonymous key; flag bucketing may change between restarts.');
    }
    return new AnonymousKeyStore(anonymousKey);
  }
}
