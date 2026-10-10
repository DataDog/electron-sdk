import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs/promises';
import { display } from '../../tools/display';

vi.mock('node:fs/promises');

const { AnonymousKeyStore } = await import('./AnonymousKeyStore');

const readFile = vi.mocked(fs.readFile);
const writeFile = vi.mocked(fs.writeFile);
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  readFile.mockReset();
  writeFile.mockReset();
  warnSpy = vi.spyOn(display, 'warn').mockImplementation(() => undefined);
});

describe('AnonymousKeyStore', () => {
  it('generates and persists a UUID on first start', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    writeFile.mockResolvedValue(undefined);
    const store = await AnonymousKeyStore.init('/userData');
    expect(store.anonymousKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(writeFile).toHaveBeenCalledWith('/userData/_dd_flags_anonymous_key', store.anonymousKey, 'utf-8');
  });

  it('reuses the persisted key', async () => {
    readFile.mockResolvedValue('123e4567-e89b-12d3-a456-426614174000');
    const store = await AnonymousKeyStore.init('/userData');
    expect(store.anonymousKey).toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('regenerates on an unreadable file and warns', async () => {
    readFile.mockRejectedValue(new Error('EACCES'));
    writeFile.mockResolvedValue(undefined);
    const store = await AnonymousKeyStore.init('/userData');
    expect(store.anonymousKey).not.toBe('123e4567-e89b-12d3-a456-426614174000');
    expect(writeFile).toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  it('regenerates on a file with an invalid key', async () => {
    readFile.mockResolvedValue('not a uuid');
    writeFile.mockResolvedValue(undefined);
    const store = await AnonymousKeyStore.init('/userData');
    expect(store.anonymousKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(writeFile).toHaveBeenCalled();
  });

  it('write failure keeps an in-memory key and warns via display', async () => {
    readFile.mockRejectedValue(new Error('ENOENT'));
    writeFile.mockRejectedValue(new Error('disk full'));
    const store = await AnonymousKeyStore.init('/userData');
    expect(store.anonymousKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(warnSpy).toHaveBeenCalled();
  });
});
