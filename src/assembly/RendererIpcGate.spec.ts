import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RendererIpcGate } from './RendererIpcGate';
import type { IpcMainEvent } from 'electron';
import { createMockSender, type MockSender } from '../mocks.specUtil';

vi.mock('../domain/telemetry', () => ({
  monitor: (fn: unknown) => fn,
}));

function createMockIpcEvent(
  opts: {
    senderFrame?: { origin: string; url?: string } | null;
    processId?: number;
    frameId?: number;
    sender?: MockSender;
  } = {}
): IpcMainEvent {
  return {
    senderFrame: 'senderFrame' in opts ? opts.senderFrame : { origin: 'https://any.example.com' },
    processId: opts.processId ?? 1,
    frameId: opts.frameId ?? 1,
    sender: opts.sender ?? createMockSender(),
  } as unknown as IpcMainEvent;
}

describe('RendererIpcGate', () => {
  let gate: RendererIpcGate;

  beforeEach(() => {
    vi.clearAllMocks();
    gate = new RendererIpcGate([]);
  });

  describe('origin enforcement', () => {
    it('allows a message from an allowed origin', () => {
      gate = new RendererIpcGate(['example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://example.com' } }))).toBe(true);
    });

    it('blocks a message from a disallowed origin', () => {
      gate = new RendererIpcGate(['example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://other.com' } }))).toBe(false);
    });

    it("allows any origin when allowedRendererHosts contains '*'", () => {
      gate = new RendererIpcGate(['*', '']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://anything.example.com' } }))).toBe(
        true
      );
    });

    it("allows file:// origin when allowedRendererHosts contains ''", () => {
      gate = new RendererIpcGate(['']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'file://' } }))).toBe(true);
    });

    it('blocks file:// origin when not in allowedRendererHosts', () => {
      gate = new RendererIpcGate(['example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'file://' } }))).toBe(false);
    });

    it("does not allow a trailing-dot remote origin when allowedRendererHosts contains only ''", () => {
      // '' is the file:// sentinel; a remote origin whose hostname ends with '.' must not match it
      gate = new RendererIpcGate(['']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://attacker.example./' } }))).toBe(false);
    });

    it('allows a subdomain when the parent domain is in allowedRendererHosts', () => {
      gate = new RendererIpcGate(['example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://sub.example.com' } }))).toBe(true);
    });

    it('allows a wildcard pattern match', () => {
      gate = new RendererIpcGate(['preview-*.example.com']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://preview-abc123.example.com' } }))
      ).toBe(true);
    });

    it('allows a wildcard match with an empty captured segment (mirrors Browser SDK semantics)', () => {
      // 'preview-*.example.com' should match 'preview-.example.com' (empty * capture),
      // consistent with the Browser SDK's matchesHostEntry using >= not >.
      gate = new RendererIpcGate(['preview-*.example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://preview-.example.com' } }))).toBe(
        true
      );
    });

    it('does not allow apex domain when only a subdomain wildcard is listed', () => {
      gate = new RendererIpcGate(['*.example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'https://example.com' } }))).toBe(false);
    });

    it('allows a custom-protocol renderer when origin is null but URL host matches allowedRendererHosts', () => {
      // Non-standard schemes (not registered as privileged) report senderFrame.origin as 'null'.
      // We fall back to the frame URL to extract the host.
      gate = new RendererIpcGate(['myapp']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'myapp://myapp/index.html' } }))
      ).toBe(true);
    });

    it('blocks a custom-protocol renderer when origin is null and URL host is not in allowedRendererHosts', () => {
      gate = new RendererIpcGate(['other']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'myapp://myapp/index.html' } }))
      ).toBe(false);
    });

    it('preserves custom-protocol hostname case in resolveOrigin', () => {
      // allowedRendererHosts entries are stored as-is; the runtime hostname must match exactly.
      gate = new RendererIpcGate(['MyApp']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'app://MyApp/index.html' } }))
      ).toBe(true);
    });

    it('rejects a custom-protocol hostname when case does not match', () => {
      gate = new RendererIpcGate(['myapp']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'app://MyApp/index.html' } }))
      ).toBe(false);
    });

    it("allows a file:// renderer when origin is null but URL is file:// and '' is in allowedRendererHosts", () => {
      // Guard against a hypothetical future where Electron reports 'null' for file:// sub-frames.
      gate = new RendererIpcGate(['']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'file:///path/to/renderer.html' } }))
      ).toBe(true);
    });

    it("allows a data: URL renderer when allowedRendererHosts is ['*']", () => {
      // data: URLs have origin 'null' and no hostname — the wildcard must fire before resolveOrigin
      // so they are not silently dropped when the user explicitly allows all renderers.
      gate = new RendererIpcGate(['*', '']);
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: { origin: 'null', url: 'data:text/html,<h1>hello</h1>' } }))
      ).toBe(true);
    });

    it('blocks a message when senderFrame is missing entirely', () => {
      gate = new RendererIpcGate(['*', '']);
      expect(gate.isAllowed({} as IpcMainEvent)).toBe(false);
    });
  });

  describe('null senderFrame after frame destruction', () => {
    it('allows a message from a previously verified frame when senderFrame is null', () => {
      // Simulates a profiling flush or final RUM event sent during page unload:
      // senderFrame goes null after the frame is destroyed, but processId+frameId survive.
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 42, frameId: 7, sender })
        )
      ).toBe(true);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender }))).toBe(true);
    });

    it('accepts multiple null-senderFrame IPCs from a previously verified frame', () => {
      // Multiple teardown IPCs (e.g. a final RUM event AND a profile flush) must all be accepted.
      // The key persists until did-frame-navigate or WebContents 'destroyed' fires; it is NOT
      // evicted on the first null-senderFrame IPC.
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 42, frameId: 7, sender })
        )
      ).toBe(true);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender }))).toBe(true);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender }))).toBe(true);
    });

    it('blocks a message from an unrecognized frame when senderFrame is null', () => {
      gate = new RendererIpcGate(['example.com']);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 99, frameId: 9 }))).toBe(false);
    });

    it('rejects null-senderFrame IPC when sender does not own the frame key', () => {
      // Defense-in-depth: even if a frame key is in allowedFrames, a null-senderFrame IPC from a
      // different WebContents that happens to use the same routing slot must be rejected.
      gate = new RendererIpcGate(['example.com']);
      const sender1 = createMockSender();
      const sender2 = createMockSender();

      // W1 registers key "42:7"
      expect(
        gate.isAllowed(
          createMockIpcEvent({
            senderFrame: { origin: 'https://example.com' },
            processId: 42,
            frameId: 7,
            sender: sender1,
          })
        )
      ).toBe(true);

      // null-senderFrame from W2 with same key — rejected (W2 doesn't own key)
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender: sender2 }))
      ).toBe(false);

      // null-senderFrame from W1 — accepted (W1 owns key)
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender: sender1 }))
      ).toBe(true);
    });

    it('blocks a null-senderFrame message after the frame navigates to a different document', () => {
      // Simulates the attack scenario: frame at allowed origin verifies, then navigates
      // to a disallowed origin. The did-frame-navigate event must evict the stale key so
      // subsequent null-senderFrame messages from the evil page are rejected.
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      // Frame verified — key "42:7" added
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 42, frameId: 7, sender })
        )
      ).toBe(true);

      // Frame navigates to evil.com — did-frame-navigate fires, key "42:7" evicted
      sender.triggerFrameNavigate(42, 7);

      // null-senderFrame from same processId:frameId — must be blocked
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender }))).toBe(false);
    });

    it('does not accumulate did-frame-navigate listeners across frame reloads', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);

      sender.triggerFrameNavigate(1, 1);
      expect(sender.listenerCount('did-frame-navigate')).toBe(0);

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
    });

    it('does not accumulate destroyed listeners across frame navigations', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      expect(sender.listenerCount('destroyed')).toBe(1);

      sender.triggerFrameNavigate(1, 1);
      expect(sender.listenerCount('destroyed')).toBe(0);
      expect(sender.listenerCount('did-frame-navigate')).toBe(0);

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      expect(sender.listenerCount('destroyed')).toBe(1);
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
    });

    it('installs exactly one did-frame-navigate and one destroyed listener for multiple frames on the same WebContents', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 2, sender })
      );
      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 3, sender })
      );

      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
      expect(sender.listenerCount('destroyed')).toBe(1);
    });

    it('removes WebContents listeners only when the last frame evicts via did-frame-navigate', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 1, sender })
      );
      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 1, frameId: 2, sender })
      );

      // Navigate frame 1: 1 frame remaining — listeners still installed
      sender.triggerFrameNavigate(1, 1);
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
      expect(sender.listenerCount('destroyed')).toBe(1);

      // Navigate frame 2: last frame evicted — listeners removed
      sender.triggerFrameNavigate(1, 2);
      expect(sender.listenerCount('did-frame-navigate')).toBe(0);
      expect(sender.listenerCount('destroyed')).toBe(0);
    });

    it('evicts all frames when WebContents is destroyed', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 10, frameId: 1, sender })
      );
      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 10, frameId: 2, sender })
      );

      sender.triggerDestroyed();

      // Both frameKeys must now be rejected
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 10, frameId: 1 }))).toBe(false);
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 10, frameId: 2 }))).toBe(false);
      expect(sender.listenerCount('destroyed')).toBe(0);
    });

    it('transfers frame key ownership when a routing slot is reused by a different WebContents', () => {
      // Scenario: frame on W1 gets key K registered. W2 silently reuses the same routing slot K
      // (different WebContents, e.g. a webview or popup). W1 is then destroyed — it must NOT
      // delete K from allowedFrames since K now belongs to W2.
      gate = new RendererIpcGate(['example.com']);
      const sender1 = createMockSender();
      const sender2 = createMockSender();

      // W1 registers key "42:7"
      expect(
        gate.isAllowed(
          createMockIpcEvent({
            senderFrame: { origin: 'https://example.com' },
            processId: 42,
            frameId: 7,
            sender: sender1,
          })
        )
      ).toBe(true);

      // W2 reuses the same routing slot — key "42:7" transfers ownership to W2
      expect(
        gate.isAllowed(
          createMockIpcEvent({
            senderFrame: { origin: 'https://example.com' },
            processId: 42,
            frameId: 7,
            sender: sender2,
          })
        )
      ).toBe(true);

      // W1 is destroyed — must NOT evict key "42:7" (it now belongs to W2)
      sender1.triggerDestroyed();

      // null-senderFrame IPC from W2 — must still be allowed
      expect(
        gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7, sender: sender2 }))
      ).toBe(true);
    });

    it('blocks a null-senderFrame message after the WebContents is destroyed', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 42, frameId: 7, sender })
        )
      ).toBe(true);

      sender.triggerDestroyed();

      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 42, frameId: 7 }))).toBe(false);
    });
  });

  describe('iframe removed without navigation (evict-on-reuse)', () => {
    // Electron 39–41 does not expose a render-frame-deleted event, so eviction of a
    // removed iframe is deferred until the processId:frameId slot is reused. Slot reuse is
    // detected by origin re-validation on every senderFrame-present IPC.

    it('evicts the stale entry and re-verifies when a removed frame slot is reused by an allowed origin', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      // First frame: verified and recorded via senderFrame object A
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 5, frameId: 3, sender })
        )
      ).toBe(true);

      // Same slot reused (still allowed origin) — origin re-validated and message accepted
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 5, frameId: 3, sender })
        )
      ).toBe(true);
    });

    it('evicts the stale entry before rejecting when a removed frame slot is reused by a disallowed origin', () => {
      // Eviction must happen on the disallowed-origin IPC: if the stale key were left after
      // rejecting the disallowed frame, a subsequent null-senderFrame IPC (e.g. unload flush)
      // from that same slot would be accepted as "previously verified".
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 5, frameId: 3, sender })
        )
      ).toBe(true);

      // Slot reused by a disallowed origin: stale key must be evicted, new frame rejected
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://evil.com' }, processId: 5, frameId: 3, sender })
        )
      ).toBe(false);

      // Stale key was evicted: a null-senderFrame message from the same slot must now be rejected
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 5, frameId: 3 }))).toBe(false);
    });

    it('re-validates origin on every IPC when senderFrame is present, even for already-allowed frames', () => {
      // The security invariant: allowedFrames is only consulted for null-senderFrame IPCs.
      // When senderFrame is present, origin is always re-checked.
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      // Allowed origin — accepted, frame registered
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 7, frameId: 2, sender })
        )
      ).toBe(true);

      // Same slot, disallowed origin (simulate silent iframe removal + slot reuse by evil frame)
      expect(
        gate.isAllowed(
          createMockIpcEvent({ senderFrame: { origin: 'https://evil.com' }, processId: 7, frameId: 2, sender })
        )
      ).toBe(false);

      // Key was evicted in previous call: null-senderFrame IPC from same slot is also rejected
      expect(gate.isAllowed(createMockIpcEvent({ senderFrame: null, processId: 7, frameId: 2 }))).toBe(false);
    });

    it('removes stale listeners when a removed frame slot is reused by an allowed origin', () => {
      gate = new RendererIpcGate(['example.com']);
      const sender = createMockSender();

      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 5, frameId: 3, sender })
      );
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
      expect(sender.listenerCount('destroyed')).toBe(1);

      // Slot reused by new allowed frame: registerAllowedFrame is idempotent for same sender
      gate.isAllowed(
        createMockIpcEvent({ senderFrame: { origin: 'https://example.com' }, processId: 5, frameId: 3, sender })
      );
      expect(sender.listenerCount('did-frame-navigate')).toBe(1);
      expect(sender.listenerCount('destroyed')).toBe(1);
    });
  });
});
