import { type MockInstance } from 'vitest';
import * as fs from 'node:fs/promises';
import type { Configuration } from './config';
import { RawRumView, RumActionEvent, RumErrorEvent, RumEvent, RumResourceEvent, RumViewEvent } from './domain/rum';
import { combine, mergeInto, RecursivePartial, ServerDuration } from '@datadog/browser-core';

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
        name: 'name',
        url: 'url',
        time_spent: 0 as ServerDuration,
        is_active: true,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: 1 },
    },
    overrides
  ) as RawRumView;
}

export function createServerRumEvent<T extends RumEvent>(type: RumEvent['type'], overrides?: RecursivePartial<T>): T {
  if (type === 'view') {
    return createServerRumView(overrides as RecursivePartial<RumViewEvent>) as T;
  }
  if (type === 'resource') {
    return createServerRumResource(overrides as RecursivePartial<RumResourceEvent>) as T;
  }
  if (type === 'error') {
    return createServerRumError(overrides as RecursivePartial<RumErrorEvent>) as T;
  }
  if (type === 'action') {
    return createServerRumAction(overrides as RecursivePartial<RumActionEvent>) as T;
  }
  throw new Error(`Unhandled type: '${type}'`);
}

const SERVER_EVENT_COMMON_CONTEXT = {
  application: {
    id: 'app-id',
  },
  session: {
    id: '2',
    type: 'user',
  },
  view: {
    id: '1',
    name: 'name',
    url: 'url',
  },
  _dd: { format_version: 2 },
};

export function createServerRumView(overrides?: RecursivePartial<RumViewEvent>): RumViewEvent {
  return combine(
    {
      type: 'view' as const,
      date: Date.now(),
      view: {
        time_spent: 0,
        action: { count: 0 },
        error: { count: 0 },
        resource: { count: 0 },
      },
      _dd: { document_version: 1 },
    },
    SERVER_EVENT_COMMON_CONTEXT,
    overrides
  ) as RumViewEvent;
}

export function createServerRumResource(overrides?: RecursivePartial<RumResourceEvent>): RumResourceEvent {
  return combine(
    {
      type: 'resource' as const,
      date: Date.now(),
      resource: {
        type: 'fetch',
        url: 'url',
      },
    },
    SERVER_EVENT_COMMON_CONTEXT,
    overrides
  ) as RumResourceEvent;
}
export function createServerRumError(overrides?: RecursivePartial<RumErrorEvent>): RumErrorEvent {
  return combine(
    {
      type: 'error' as const,
      date: Date.now(),
      error: {
        message: 'Oops',
        source: 'source',
      },
    },
    SERVER_EVENT_COMMON_CONTEXT,
    overrides
  ) as RumErrorEvent;
}
export function createServerRumAction(overrides?: RecursivePartial<RumActionEvent>): RumActionEvent {
  return combine(
    {
      type: 'action' as const,
      date: Date.now(),
      action: {
        type: 'custom',
      },
    },
    SERVER_EVENT_COMMON_CONTEXT,
    overrides
  ) as RumActionEvent;
}
