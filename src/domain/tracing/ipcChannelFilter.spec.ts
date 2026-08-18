import { describe, it, expect } from 'vitest';
import { isExcludedIpcChannel } from './ipcChannelFilter';

describe('isExcludedIpcChannel', () => {
  it('excludes datadog:-prefixed channels', () => {
    expect(isExcludedIpcChannel('datadog:bridge-send')).toBe(true);
    expect(isExcludedIpcChannel('datadog:bridge-config')).toBe(true);
  });

  it('excludes the hardcoded get-internal-context channel', () => {
    expect(isExcludedIpcChannel('get-internal-context')).toBe(true);
  });

  it('does not exclude other channels', () => {
    expect(isExcludedIpcChannel('ipc-demo:get-profile')).toBe(false);
    expect(isExcludedIpcChannel('stop-session')).toBe(false);
  });
});
