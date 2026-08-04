import { DISCARDED } from '@datadog/js-core/assembly';
import type { TimeStamp } from '@datadog/js-core/time';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFormatHooks } from '../../assembly';
import { isTraceSampled } from '../../common';
import { EventKind, EventManager, EventSource, LifecycleKind } from '../../event';
import { createTestConfiguration } from '../../mocks.specUtil';
import { TraceSampling } from './TraceSampling';

const LOW_HASH_UUID = '29a4b5e3-9859-4290-99fa-4bc4a1a348b9';
const HIGH_HASH_UUID = '5321b54a-d6ec-4b24-996d-dd70c617e09a';

describe('TraceSampling', () => {
  beforeEach(() => {
    delete (globalThis as Record<symbol, unknown>)[Symbol.for('@datadog/electron-sdk:traceSamplingState')];
  });

  function setup(id: string, traceSampleRate: number) {
    const eventManager = new EventManager();
    const hooks = createFormatHooks();
    const session = { id, status: 'active' as 'active' | 'expired' };
    const sessionManager = {
      getSession: () => ({ ...session }),
      getTrackedSessionId: () => (session.status === 'active' ? session.id : undefined),
    };
    new TraceSampling(
      eventManager,
      sessionManager,
      createTestConfiguration({ sessionSampleRate: 100, traceSampleRate }),
      hooks
    );
    return { eventManager, hooks, session };
  }

  it('uses one deterministic decision for instrumentation and span assembly', () => {
    const { hooks } = setup(HIGH_HASH_UUID, 50);

    expect(isTraceSampled()).toBe(false);
    expect(hooks.triggerSpan({ startTime: 1 as TimeStamp, source: EventSource.MAIN })).toBe(DISCARDED);
  });

  it('applies traceSampleRate as a child of sessionSampleRate', () => {
    const eventManager = new EventManager();
    const hooks = createFormatHooks();
    const sessionManager = {
      getSession: () => ({ id: LOW_HASH_UUID, status: 'active' as const }),
      getTrackedSessionId: () => LOW_HASH_UUID,
    };
    new TraceSampling(
      eventManager,
      sessionManager,
      createTestConfiguration({ sessionSampleRate: 0, traceSampleRate: 100 }),
      hooks
    );

    expect(isTraceSampled()).toBe(false);
  });

  it('blocks new instrumentation when the session expires', () => {
    const { eventManager } = setup(LOW_HASH_UUID, 100);
    expect(isTraceSampled()).toBe(true);

    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_EXPIRED });

    expect(isTraceSampled()).toBe(false);
  });

  it('redraws the decision when the session renews', () => {
    const { eventManager, session } = setup(HIGH_HASH_UUID, 50);
    expect(isTraceSampled()).toBe(false);
    session.id = LOW_HASH_UUID;

    eventManager.notify({ kind: EventKind.LIFECYCLE, lifecycle: LifecycleKind.SESSION_RENEW });

    expect(isTraceSampled()).toBe(true);
  });
});
