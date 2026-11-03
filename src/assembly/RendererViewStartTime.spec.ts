import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ONE_MINUTE, type TimeStamp } from '@datadog/js-core/time';
import { RendererViewStartTime } from './RendererViewStartTime';
import type { RendererRumEvent } from '../domain/rum';

const VIEW_START = 1000 as TimeStamp;
const S2_START = 20 * ONE_MINUTE;
const S3_START = 60 * ONE_MINUTE;
const MOVE_TIME = S3_START - 2 * ONE_MINUTE;

describe('RendererViewStartTime', () => {
  // Session S1 covers [0, S2_START), S2 covers [S2_START, S3_START), S3 covers [S3_START, ∞).
  let currentSessionId: string | undefined;
  let viewStartTime: RendererViewStartTime;

  function sessionAt(at: TimeStamp): string {
    if (at < S2_START) return 'session-1';
    return at < S3_START ? 'session-2' : 'session-3';
  }

  function view({ isActive = true, id = 'view-1' } = {}): RendererRumEvent {
    return { type: 'view', date: VIEW_START, view: { id, is_active: isActive } } as unknown as RendererRumEvent;
  }

  function setNow(sessionId: string | undefined, now: number) {
    currentSessionId = sessionId;
    vi.setSystemTime(now);
  }

  function moveViewToS2() {
    setNow('session-2', MOVE_TIME);
    viewStartTime.resolve(view());
  }

  beforeEach(() => {
    vi.useFakeTimers({ now: VIEW_START });
    currentSessionId = 'session-1';
    viewStartTime = new RendererViewStartTime({
      // The session covering now is the current one.
      getTrackedSessionId: (at?: TimeStamp) =>
        at === undefined || at >= Date.now() ? currentSessionId : sessionAt(at),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the date of a view still in the session it started in', () => {
    expect(viewStartTime.resolve(view())).toBe(VIEW_START);
  });

  it('moves a view started in an earlier session to the current one, at the move time for later updates too', () => {
    setNow('session-2', MOVE_TIME);
    expect(viewStartTime.resolve(view())).toBe(MOVE_TIME);

    vi.setSystemTime(MOVE_TIME + ONE_MINUTE);
    expect(viewStartTime.resolve(view())).toBe(MOVE_TIME);
  });

  it('moves a view again at each session change', () => {
    moveViewToS2();

    setNow('session-3', S3_START + ONE_MINUTE);
    expect(viewStartTime.resolve(view())).toBe(S3_START + ONE_MINUTE);
  });

  it('keeps a view in the session it started in while no session is tracked', () => {
    setNow(undefined, MOVE_TIME);

    expect(viewStartTime.resolve(view())).toBe(VIEW_START);
  });

  it('keeps a moved view in the session it moved to while no session is tracked', () => {
    moveViewToS2();

    setNow(undefined, S3_START + ONE_MINUTE);
    expect(viewStartTime.resolve(view())).toBe(MOVE_TIME);
  });

  it('keeps an ended view in the session it started in, so a session change does not move a finished view', () => {
    setNow('session-2', MOVE_TIME);

    expect(viewStartTime.resolve(view({ isActive: false }))).toBe(VIEW_START);
  });

  it('keeps an ended view in the session it moved to, including the updates sent after its end', () => {
    moveViewToS2();

    setNow('session-3', S3_START + ONE_MINUTE);
    expect(viewStartTime.resolve(view({ isActive: false }))).toBe(MOVE_TIME);
    vi.setSystemTime(S3_START + 4 * ONE_MINUTE);
    expect(viewStartTime.resolve(view({ isActive: false }))).toBe(MOVE_TIME);
  });

  it('remembers a moved view however long it stays silent (e.g. a suspended renderer)', () => {
    moveViewToS2();

    setNow(undefined, MOVE_TIME + 24 * 60 * ONE_MINUTE);
    expect(viewStartTime.resolve(view())).toBe(MOVE_TIME);
  });

  it('caps the moved views it remembers, forgetting the oldest move first', () => {
    setNow('session-2', MOVE_TIME);
    for (let i = 0; i <= 100; i++) {
      viewStartTime.resolve(view({ id: `view-${i}` }));
    }

    // Forgotten views resolve from their date again, back in the session they started in.
    setNow(undefined, MOVE_TIME + ONE_MINUTE);
    expect(viewStartTime.resolve(view({ id: 'view-0' }))).toBe(VIEW_START);
    expect(viewStartTime.resolve(view({ id: 'view-100' }))).toBe(MOVE_TIME);
  });

  it('counts a view moved again as the newest move for the cap', () => {
    moveViewToS2();
    for (let i = 0; i < 50; i++) {
      viewStartTime.resolve(view({ id: `s2-view-${i}` }));
    }
    setNow('session-3', S3_START + ONE_MINUTE);
    viewStartTime.resolve(view());
    // 51 more moves push the map 2 entries past the cap: the 2 oldest moves (made in S2) are evicted.
    for (let i = 0; i < 51; i++) {
      viewStartTime.resolve(view({ id: `s3-view-${i}` }));
    }

    setNow(undefined, S3_START + 2 * ONE_MINUTE);
    expect(viewStartTime.resolve(view())).toBe(S3_START + ONE_MINUTE);
    expect(viewStartTime.resolve(view({ id: 's2-view-0' }))).toBe(VIEW_START);
  });

  it('moves a view started without a tracked session (refused consent, gap, unsampled or pruned session)', () => {
    viewStartTime = new RendererViewStartTime({
      getTrackedSessionId: (at?: TimeStamp) => (at === undefined || at >= Date.now() ? 'session-2' : undefined),
    });
    vi.setSystemTime(MOVE_TIME);

    expect(viewStartTime.resolve(view())).toBe(MOVE_TIME);
  });

  it('moves an ended view started without a tracked session, as it has no owner session to stay in', () => {
    viewStartTime = new RendererViewStartTime({
      getTrackedSessionId: (at?: TimeStamp) => (at === undefined || at >= Date.now() ? 'session-2' : undefined),
    });
    vi.setSystemTime(MOVE_TIME);

    expect(viewStartTime.resolve(view({ isActive: false }))).toBe(MOVE_TIME);
  });

  it('tracks each view separately', () => {
    moveViewToS2();

    vi.setSystemTime(MOVE_TIME + ONE_MINUTE);
    expect(viewStartTime.resolve(view({ id: 'view-2' }))).toBe(MOVE_TIME + ONE_MINUTE);
  });

  it('keeps the date of non-view events, which are already resolved in the session they happened in', () => {
    setNow('session-2', MOVE_TIME);

    expect(viewStartTime.resolve({ type: 'action', date: VIEW_START } as unknown as RendererRumEvent)).toBe(VIEW_START);
  });
});
