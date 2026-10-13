import { describe, it, expect } from 'vitest';
import { ExposureCollector, EXPOSURE_LRU_SIZE } from './ExposureCollector';
import { FlagsState } from './FlagsState';
import type { EvaluationRecord } from '../../common/flags/types';
import type { ServerExposuresEvent } from '../../event';

const anonymousContext = { targetingKey: 'anonymous-1' };

function createState(): FlagsState {
  const state = new FlagsState(anonymousContext);
  state.applyConfigurationUpdate({ configuration: 'wire-1', status: 'READY' });
  return state;
}

function record(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    flagKey: 'targeted-flag',
    variant: 'variant-a',
    allocationKey: 'targeted-pro',
    reason: 'STATIC',
    doLog: true,
    serialId: 1,
    configurationId: 'config-1',
    contextRevision: 0,
    timestamp: 100 as never,
    ...overrides,
  };
}

function createCollector(state = createState()) {
  const events: ServerExposuresEvent[] = [];
  const collector = new ExposureCollector(state, { applicationId: 'app-1', service: 'svc' }, (event) => {
    events.push(event as ServerExposuresEvent);
  });
  return { collector, events, state };
}

describe('ExposureCollector', () => {
  it('emits one exposure per (subject, attributes, flag, allocation, variant, configuration id)', () => {
    const { collector, events } = createCollector();
    collector.add(record());
    collector.add(record());
    collector.add(record());
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'server',
      track: 'exposures',
      data: {
        flag: { key: 'targeted-flag' },
        variant: { key: 'variant-a' },
        allocation: { key: 'targeted-pro' },
        subject: { id: 'anonymous-1' },
        serial_id: 1,
        service: 'svc',
        rum: { application: { id: 'app-1' }, view: { url: 'electron://main-process' } },
        timestamp: 100,
      },
    });
  });

  it('builds the payload with createExposureEvent plus service, rum.application.id, rum.view.url and timestamp', () => {
    const { collector, events } = createCollector();
    collector.add(record({ viewUrl: 'https://app.example.com/page' }));
    expect(events[0].data.rum.view.url).toBe('https://app.example.com/page');
    expect(events[0].data.service).toBe('svc');
    expect(events[0].data.rum.application.id).toBe('app-1');
  });

  it('a late record from the previous context revision does not duplicate its earlier exposure', () => {
    const { collector, events, state } = createCollector();
    collector.add(record({ contextRevision: 0 }));
    // Context changes: user-1 logs in.
    state.applyContextUpdate({ targetingKey: 'user-1', plan: 'pro' });
    // A late record still referring to the anonymous context revision.
    collector.add(record({ contextRevision: 0 }));
    expect(events).toHaveLength(1);
  });

  it('a new context emits a new exposure for the same flag', () => {
    const { collector, events, state } = createCollector();
    collector.add(record());
    state.applyContextUpdate({ targetingKey: 'user-1' });
    collector.add(record({ contextRevision: 1 }));
    expect(events).toHaveLength(2);
    expect(events[1].data.subject.id).toBe('user-1');
  });

  it('switching back to a previous context within the LRU does not re-emit', () => {
    const { collector, events, state } = createCollector();
    collector.add(record({ contextRevision: 0 }));
    state.applyContextUpdate({ targetingKey: 'user-1' });
    collector.add(record({ contextRevision: 1 }));
    state.applyContextUpdate(anonymousContext);
    collector.add(record({ contextRevision: 2 }));
    expect(events).toHaveLength(2);
    // The first exposure was for the anonymous context, the second for user-1; the
    // return to the anonymous context did not re-emit it.
    expect(events[0].data.subject.id).toBe('anonymous-1');
    expect(events[1].data.subject.id).toBe('user-1');
  });

  it('a configuration change re-emits', () => {
    const { collector, events, state } = createCollector();
    collector.add(record());
    state.applyConfigurationUpdate({ configuration: 'wire-2', status: 'READY' });
    collector.add(record({ configurationId: 'config-2' }));
    expect(events).toHaveLength(2);
  });

  it('skips errorCode, reason ERROR, missing variant and doLog false', () => {
    const { collector, events } = createCollector();
    collector.add(record({ errorCode: 'FLAG_NOT_FOUND' }));
    collector.add(record({ reason: 'ERROR' }));
    collector.add(record({ variant: undefined }));
    collector.add(record({ doLog: false }));
    collector.add(record({ allocationKey: undefined }));
    expect(events).toHaveLength(0);
  });

  it('drops records whose contextRevision is no longer retained, without telemetry', () => {
    const { collector, events, state } = createCollector();
    void state;
    for (let i = 1; i <= 12; i += 1) {
      state.applyContextUpdate({ targetingKey: `user-${i}` });
    }
    collector.add(record({ contextRevision: 0 }));
    expect(events).toHaveLength(0);
  });

  it('LRU bound evicts the oldest key', () => {
    const { collector, events } = createCollector();
    // Fill with distinct flags until the LRU is full.
    for (let i = 0; i <= EXPOSURE_LRU_SIZE; i += 1) {
      collector.add(record({ flagKey: `flag-${i}`, allocationKey: 'alloc', variant: 'v' }));
    }
    expect(events).toHaveLength(EXPOSURE_LRU_SIZE + 1);
    // flag-0 was evicted: evaluating it again emits a new exposure.
    collector.add(record({ flagKey: 'flag-0', allocationKey: 'alloc', variant: 'v' }));
    expect(events).toHaveLength(EXPOSURE_LRU_SIZE + 2);
  });

  it('stop() clears state', () => {
    const { collector, events } = createCollector();
    collector.add(record());
    collector.stop();
    collector.add(record());
    // After stop the dedupe memory is gone: the exposure is emitted again.
    expect(events).toHaveLength(2);
  });

  describe('precomputed configuration identity (D29)', () => {
    function createPrecomputedState(): FlagsState {
      const state = new FlagsState(anonymousContext);
      state.applyPrecomputedUpdate({
        configuration: 'wire-p1',
        context: anonymousContext,
        status: 'READY',
        configurationIdentity: 'created-at-1',
      });
      return state;
    }

    it('dedupes on createdAt when configurationId is absent', () => {
      const { collector, events } = createCollector(createPrecomputedState());
      collector.add(record({ configurationId: undefined }));
      collector.add(record({ configurationId: undefined }));
      expect(events).toHaveLength(1);
    });

    it('a new createdAt re-emits the same flag and variant', () => {
      const { collector, events, state } = createCollector(createPrecomputedState());
      collector.add(record({ configurationId: undefined }));
      state.applyPrecomputedUpdate({
        configuration: 'wire-p2',
        context: anonymousContext,
        status: 'READY',
        configurationIdentity: 'created-at-2',
      });
      collector.add(record({ configurationId: undefined }));
      expect(events).toHaveLength(2);
    });

    it('a late record dedupes on its own captured identity across a same-revision refresh', () => {
      const { collector, events, state } = createCollector(createPrecomputedState());
      // Pre-refresh evaluation: the record carries the createdAt it resolved with.
      collector.add(record({ configurationId: 'created-at-1' }));
      // A refresh of the same context replaces the identity retained for the revision.
      state.applyPrecomputedUpdate({
        configuration: 'wire-p2',
        context: anonymousContext,
        status: 'READY',
        configurationIdentity: 'created-at-2',
      });
      // A late pre-refresh record carrying its own captured identity: no duplicate of its
      // earlier emission. Resolving the mutable retained identity instead would re-emit.
      collector.add(record({ configurationId: 'created-at-1' }));
      expect(events).toHaveLength(1);
      // The genuine post-refresh evaluation emits: never suppressed by the late record.
      collector.add(record({ configurationId: 'created-at-2' }));
      expect(events).toHaveLength(2);
    });

    it('a late record from a previous context revision resolves its own createdAt', () => {
      const { collector, events, state } = createCollector(createPrecomputedState());
      const otherContext = { targetingKey: 'user-2' };
      // Revision 0 (created-at-1) emits once.
      collector.add(record({ configurationId: undefined }));
      // Revision 1 carries its own createdAt.
      state.applyPrecomputedUpdate({
        configuration: 'wire-p2',
        context: otherContext,
        status: 'READY',
        configurationIdentity: 'created-at-2',
      });
      // A late record from revision 0 resolves revision 0's createdAt (already emitted):
      // no duplicate. Resolving the current identity instead would emit here.
      collector.add(record({ configurationId: undefined }));
      expect(events).toHaveLength(1);
      // A record for revision 1 carries the new createdAt and emits.
      collector.add(record({ configurationId: undefined, contextRevision: 1 }));
      expect(events).toHaveLength(2);
    });
  });

  it('uses the same tuple from main and a renderer: one exposure', () => {
    const { collector, events } = createCollector();
    collector.add(record({ viewUrl: 'electron://main-process' }));
    collector.add(record({ viewUrl: 'https://app.example.com', viewId: 'view-1' }));
    expect(events).toHaveLength(1);
  });

  it('never throws on malformed records', () => {
    const { collector } = createCollector();
    expect(() => collector.add(record({ serialId: Number.NaN }))).not.toThrow();
  });
  it('a dedupe hit refreshes the entry: a reused oldest key survives insertion pressure', () => {
    const { collector, events } = createCollector();
    for (let index = 0; index < EXPOSURE_LRU_SIZE; index += 1) {
      collector.add(record({ flagKey: `flag-${index}` }));
    }
    collector.add(record({ flagKey: 'flag-0' })); // hit: flag-0 becomes the most recent
    collector.add(record({ flagKey: 'flag-new' })); // evicts flag-1, not flag-0
    expect(events).toHaveLength(EXPOSURE_LRU_SIZE + 1);
    collector.add(record({ flagKey: 'flag-0' }));
    expect(events).toHaveLength(EXPOSURE_LRU_SIZE + 1);
    collector.add(record({ flagKey: 'flag-1' }));
    expect(events).toHaveLength(EXPOSURE_LRU_SIZE + 2);
  });
});
