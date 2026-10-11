import { describe, it, expect, vi, afterEach } from 'vitest';
import { connectFlags } from '../../child/flags/ChildFlagsClient';
import { fixtureWire } from '../../common/flags/evaluationCases.specUtil';
import { EvaluationBatchIntake } from './EvaluationBatchIntake';
import { FlagsState } from './FlagsState';
import { closeAllFlagsChannels, linkFlagsChildren, openFlagsChannel } from './ChildFlagsHub';

// An `electron` module without MessageChannelMain (F2): every export the hub reaches is here except it.
vi.mock('electron', () => ({ app: { getPath: () => '/tmp' } }));

function linkedState() {
  const state = new FlagsState({ targetingKey: 'user-pro', plan: 'pro' });
  state.applyConfigurationUpdate({ configuration: fixtureWire, status: 'READY' });
  const unlink = linkFlagsChildren({
    state,
    intake: new EvaluationBatchIntake(() => undefined),
    keyStore: { anonymousKey: 'anonymous' },
  });
  return { state, unlink };
}

describe('openFlagsChannel with an electron module lacking MessageChannelMain (F2)', () => {
  afterEach(() => {
    closeAllFlagsChannels();
  });

  it('frames channels still deliver the snapshot and evaluate', () => {
    const { unlink } = linkedState();
    const ref: { child?: ReturnType<typeof connectFlags> & { receive(frame: unknown): void } } = {};
    const pending: string[] = [];
    const channel = openFlagsChannel({
      kind: 'frames',
      send: (frame) => (ref.child ? ref.child.receive(frame) : pending.push(frame)),
    });
    ref.child = connectFlags({ send: (frame) => channel.receive(frame) });
    for (const frame of pending) ref.child.receive(frame);
    expect(ref.child.status).toBe('READY');
    expect(ref.child.getStringValue('targeted-flag', 'default')).toBe('variant-a');
    ref.child.close();
    unlink();
  });

  it('worker channels still deliver the snapshot and evaluate', async () => {
    const { unlink } = linkedState();
    const channel = openFlagsChannel({ kind: 'worker' });
    const child = connectFlags(channel.port);
    expect(await child.whenReady({ timeout: 1000 })).toBe(true);
    expect(child.getStringValue('targeted-flag', 'default')).toBe('variant-a');
    child.close();
    unlink();
  });

  it('only the utility kind needs it, and says so', () => {
    expect(() => openFlagsChannel({ kind: 'utility' })).toThrow(/MessageChannelMain/);
  });
});
