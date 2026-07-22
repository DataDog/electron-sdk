import { type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Configuration } from './config';
import { RawRumView } from './domain/rum';
import { type ServerDuration } from '@datadog/js-core/time';
import { mergeInto, type RecursivePartial } from '@datadog/js-core/util';

export function mockFs() {
  const mocks = {
    access: fs.access as unknown as MockInstance,
    readFile: fs.readFile as unknown as MockInstance,
    readdir: fs.readdir as unknown as MockInstance,
    stat: fs.stat as unknown as MockInstance,
    writeFile: fs.writeFile as unknown as MockInstance,
    appendFile: fs.appendFile as unknown as MockInstance,
    unlink: fs.unlink as unknown as MockInstance,
    mkdir: fs.mkdir as unknown as MockInstance,
    rename: fs.rename as unknown as MockInstance,
    reset: () => {
      mocks.access.mockReset();
      mocks.readFile.mockReset();
      mocks.readdir.mockReset();
      mocks.stat.mockReset();
      mocks.writeFile.mockReset();
      mocks.appendFile.mockReset();
      mocks.unlink.mockReset();
      mocks.mkdir.mockReset();
      mocks.rename.mockReset();
    },
  };
  return mocks;
}
export function createTestConfiguration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    site: 'datadoghq.com',
    service: 'test-service',
    clientToken: 'test-token',
    applicationId: 'test-app-id',
    sessionSampleRate: 100,
    profilingSampleRate: 100,
    telemetrySampleRate: 100,
    defaultPrivacyLevel: 'mask',
    allowedWebViewHosts: [],
    ...overrides,
  };
}
export function createRawRumView(overrides?: RecursivePartial<RawRumView>): RawRumView {
  return mergeInto(
    {
      type: 'view' as const,
      view: {
        id: '1',
        time_spent: 0 as ServerDuration,
        is_active: true,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: 1 },
    },
    overrides
  );
}
