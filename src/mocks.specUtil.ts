import { type MockInstance, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Configuration } from './config';

export function mockFs() {
  vi.mock('node:fs/promises', () => ({
    access: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    unlink: vi.fn(),
  }));
  const mocks = {
    access: fs.access as unknown as MockInstance,
    readFile: fs.readFile as unknown as MockInstance,
    writeFile: fs.writeFile as unknown as MockInstance,
    unlink: fs.unlink as unknown as MockInstance,
    reset: () => {
      mocks.access.mockReset();
      mocks.readFile.mockReset();
      mocks.writeFile.mockReset();
      mocks.unlink.mockReset();
    },
  };
  return mocks;
}
export function createTestConfiguration(overrides: Partial<Configuration> = {}): Configuration {
  return {
    service: 'test-service',
    clientToken: 'test-token',
    applicationId: 'test-app-id',
    intakeUrl: 'https://test-intake.com',
    telemetrySampleRate: 100,
    ...overrides,
  };
}
