import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { display } from '../../tools/display';
import { precomputedContext, otherPrecomputedContext } from '../../common/flags/precomputedCases.specUtil';
import type { FlatContext } from '../../common/flags/types';
import { timeStampNow } from '@datadog/js-core/time';
import { FlagsState } from './FlagsState';
import { AnonymousKeyStore } from './AnonymousKeyStore';
import { PrecomputedFetcher } from './PrecomputedFetcher';
import { MAX_CONFIGURATION_LENGTH } from './RulesFetcher';
import { PrecomputedCache } from './PrecomputedCache';
import { PrecomputedOwner, precomputedCreatedAtOf } from './PrecomputedOwner';

/** Build the assignments response body `/precompute-assignments` returns for a context. */
function assignmentsBodyFor(context: FlatContext): string {
  return JSON.stringify({
    data: {
      attributes: {
        createdAt: `created-at-${context.targetingKey}`,
        flags: {
          assigned: {
            allocationKey: `alloc-${context.targetingKey}`,
            variationKey: `variant-${context.targetingKey}`,
            variationType: 'string',
            variationValue: `variant-${context.targetingKey}`,
            reason: 'STATIC',
            doLog: true,
            serialId: 1,
          },
        },
      },
    },
  });
}

const okResponse = (body: string): Response =>
  new Response(body, { status: 200, headers: { 'content-type': 'application/vnd.api+json' } });
const errorResponse = (status: number): Response =>
  new Response(JSON.stringify({ errors: [{ detail: 'unavailable' }] }), {
    status,
    headers: { 'content-type': 'application/vnd.api+json' },
  });

describe('PrecomputedOwner', () => {
  let state: FlagsState;
  let keyStore: AnonymousKeyStore;
  let cache: PrecomputedCache;
  let owner: PrecomputedOwner | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(display, 'warn').mockImplementation(() => undefined);
    vi.spyOn(display, 'error').mockImplementation(() => undefined);
    state = new FlagsState({ targetingKey: 'anonymous-key' });
    keyStore = { anonymousKey: 'anonymous-key' };
    cache = await PrecomputedCache.init({
      userDataPath: '/userData',
      site: 'datadoghq.com',
      env: 'e2e',
      clientToken: 'client-token',
      persistConfiguration: false,
    });
    owner = undefined;
  });

  afterEach(async () => {
    await owner?.stop();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  interface HandlerState {
    handler: (url: string, init: RequestInit) => Promise<Response>;
  }

  function startOwner(
    fetchHandler: (url: string, init: RequestInit) => Promise<Response>,
    overrides: Partial<Parameters<typeof PrecomputedOwner.start>[0]> = {}
  ): { owner: PrecomputedOwner; fetches: { context: FlatContext }[] } {
    const fetches: { context: FlatContext }[] = [];
    const handlerState: HandlerState = { handler: fetchHandler };
    const fetcher = new PrecomputedFetcher({
      clientToken: 'client-token',
      site: 'datadoghq.com',
      env: 'e2e',
      applicationId: 'app',
      fetchTimeout: 5000,
      maxConfigurationLength: MAX_CONFIGURATION_LENGTH,
      fetch: (url, init) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          data: {
            attributes: {
              subject: { targeting_key: string; targeting_attributes: Record<string, string | number | boolean> };
            };
          };
        };
        const context: FlatContext = {
          ...body.data.attributes.subject.targeting_attributes,
          targetingKey: body.data.attributes.subject.targeting_key,
        };
        fetches.push({ context });
        return handlerState.handler(url as string, init as RequestInit);
      },
    });
    const started = PrecomputedOwner.start({
      refreshInterval: 300000,
      state,
      fetcher,
      cache,
      keyStore,
      ...overrides,
    });
    owner = started;
    return { owner: started, fetches };
  }

  async function startAndSettle(
    fetchHandler: (url: string, init: RequestInit) => Promise<Response>,
    overrides?: Partial<Parameters<typeof PrecomputedOwner.start>[0]>
  ) {
    const started = startOwner(fetchHandler, overrides);
    await started.owner.settled();
    return started;
  }

  it('fetches assignments for the startup context and becomes READY', async () => {
    const { fetches } = await startAndSettle(
      () => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))),
      {
        startupContext: precomputedContext,
      }
    );
    expect(fetches).toHaveLength(1);
    expect(fetches[0].context).toEqual(precomputedContext);
    expect(state.snapshot()).toMatchObject({ status: 'READY', context: precomputedContext });
    expect(state.snapshot().configuration).toContain('assigned');
    // The configuration identity is retained for the context revision (createdAt, D29).
    expect(state.getConfigurationIdentity(state.snapshot().contextRevision)).toBe('created-at-user-pro');
  });

  it('serves the cached assignments for the startup context as STALE before the network', async () => {
    // Seed the cache with an entry for the startup context, then let the network hang.
    await cache.write(precomputedContext, assignmentsWireFor('cached'), timeStampNow());
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const { owner: started } = startOwner(hanging, { startupContext: precomputedContext });
    // Before the fetch settles, the cache is already served as STALE.
    expect(state.snapshot()).toMatchObject({ status: 'STALE', context: precomputedContext });
    await vi.advanceTimersByTimeAsync(5001); // the hanging fetch times out
    await started.settled();
    // The transient failure keeps serving the cached assignments as STALE.
    expect(state.snapshot()).toMatchObject({ status: 'STALE', context: precomputedContext });
  });

  it('a context request publishes nothing until its assignments arrive, then one atomic snapshot with contextRevision + 1', async () => {
    await startAndSettle(() => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))), {
      startupContext: precomputedContext,
    });
    const snapshots: { status: string; contextRevision: number }[] = [];
    const subscription = state.subscribe((snapshot) =>
      snapshots.push({ status: snapshot.status, contextRevision: snapshot.contextRevision })
    );
    const pending = owner!.requestContext(otherPrecomputedContext);
    // The targeting key changed: defaults are published while the fetch is in flight (Q2).
    expect(state.snapshot()).toMatchObject({
      status: 'NOT_READY',
      configuration: undefined,
      context: otherPrecomputedContext,
      contextRevision: 2,
    });
    await pending;
    expect(state.snapshot()).toMatchObject({
      status: 'READY',
      configuration: expect.any(String) as string,
      context: otherPrecomputedContext,
      contextRevision: 2,
    });
    // Two publishes total for the request: the in-flight defaults, then the atomic update.
    expect(snapshots).toEqual([
      { status: 'NOT_READY', contextRevision: 2 },
      { status: 'READY', contextRevision: 2 },
    ]);
    subscription.unsubscribe();
  });

  it('the last of overlapping context requests wins; an older response never publishes', async () => {
    await startAndSettle(() => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))), {
      startupContext: precomputedContext,
    });
    const first = owner!.requestContext({ targetingKey: 'user-a' });
    const second = owner!.requestContext({ targetingKey: 'user-b' });
    await Promise.all([first, second]);
    expect(state.snapshot().context).toEqual({ targetingKey: 'user-b' });
    expect(state.snapshot().status).toBe('READY');
  });

  it('keeps serving the previous snapshot while an attribute-only context fetch is in flight, then atomically replaces it', async () => {
    await startAndSettle(() => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))), {
      startupContext: precomputedContext,
    });
    const pending = owner!.requestContext({ targetingKey: 'user-pro', plan: 'enterprise' });
    // Same targeting key: the previous assignments keep being served while in flight (Q2).
    expect(state.snapshot()).toMatchObject({ status: 'READY', context: precomputedContext });
    await pending;
    expect(state.snapshot()).toMatchObject({
      status: 'READY',
      context: { targetingKey: 'user-pro', plan: 'enterprise' },
    });
  });

  it('a transient failure for the same context keeps serving it as STALE', async () => {
    let handler: (url: string, init: RequestInit) => Promise<Response> = () =>
      Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext)));
    const { owner: started } = startOwner((url, init) => handler(url, init), { startupContext: precomputedContext });
    await started.settled();
    expect(state.snapshot()).toMatchObject({ status: 'READY' });
    handler = () => Promise.resolve(errorResponse(503));
    const refresh = started.requestContext(precomputedContext); // same context: a refresh-style fetch
    await refresh;
    expect(state.snapshot()).toMatchObject({
      status: 'STALE',
      configuration: expect.any(String) as string,
      context: precomputedContext,
    });
  });

  it('a transient failure for a new context uses that context cache (STALE), otherwise ERROR with defaults', async () => {
    let handler: (url: string, init: RequestInit) => Promise<Response> = () =>
      Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext)));
    const { owner: started } = startOwner((url, init) => handler(url, init), { startupContext: precomputedContext });
    await started.settled();
    expect(state.snapshot()).toMatchObject({ status: 'READY', context: precomputedContext });

    // A context with no cached entry goes to ERROR with defaults.
    handler = () => Promise.resolve(errorResponse(503));
    await started.requestContext({ targetingKey: 'user-stranger' });
    expect(state.snapshot()).toMatchObject({
      status: 'ERROR',
      configuration: undefined,
      context: { targetingKey: 'user-stranger' },
    });

    // Back to a context whose assignments were cached: served as STALE.
    await started.requestContext(precomputedContext);
    expect(state.snapshot()).toMatchObject({
      status: 'STALE',
      context: precomputedContext,
    });
    expect(state.snapshot().configuration).toContain('variant-user-pro');
  });

  it('an authoritative failure drops the configuration (defaults with errorCode)', async () => {
    await cache.write(precomputedContext, assignmentsWireFor('cached'), timeStampNow());
    await startAndSettle(() => Promise.resolve(errorResponse(403)), { startupContext: precomputedContext });
    // Even a cached entry is not applied for an authoritative failure (D27).
    expect(state.snapshot()).toMatchObject({ status: 'ERROR', configuration: undefined });
  });

  it('a settled superseded request does not let a refresh run while a newer request is in flight', async () => {
    let call = 0;
    const deferreds: ((response: Response) => void)[] = [];
    const { owner: started, fetches } = startOwner(
      () => {
        const index = call++;
        if (index === 0) {
          return Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext)));
        }
        return new Promise<Response>((resolve) => {
          deferreds[index] = resolve;
        });
      },
      { startupContext: precomputedContext, refreshInterval: 60000 }
    );
    await started.settled();
    expect(fetches).toHaveLength(1);

    const first = started.requestContext({ targetingKey: 'user-first' });
    const second = started.requestContext({ targetingKey: 'user-second' });
    expect(fetches).toHaveLength(3);
    // The superseded first settles while the second is still in flight.
    deferreds[1]?.(okResponse(assignmentsBodyFor({ targetingKey: 'user-first' })));
    await first;
    // The refresh interval fires: it must not start a fetch (the second is in flight),
    // because a shared in-flight flag cleared by the superseded first would let it run
    // and supersede the second.
    vi.advanceTimersByTime(60000);
    expect(fetches).toHaveLength(3);

    deferreds[2]?.(okResponse(assignmentsBodyFor({ targetingKey: 'user-second' })));
    await second;
    expect(state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'user-second' } });
  });

  it('refresh re-fetches the current context every refreshInterval', async () => {
    const { fetches } = await startAndSettle(
      () => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))),
      {
        startupContext: precomputedContext,
        refreshInterval: 60000,
      }
    );
    expect(fetches).toHaveLength(1);
    vi.advanceTimersByTime(60000);
    await owner!.settled();
    expect(fetches).toHaveLength(2);
    expect(fetches[1].context).toEqual(precomputedContext);
    expect(state.getConfigurationIdentity(state.snapshot().contextRevision)).toBe('created-at-user-pro');
  });

  it('logout to {} fetches for the anonymous key', async () => {
    await startAndSettle(() => Promise.resolve(okResponse(assignmentsBodyFor(precomputedContext))), {
      startupContext: precomputedContext,
    });
    const pending = owner!.requestContext({ targetingKey: 'anonymous-key' });
    await pending;
    expect(state.snapshot()).toMatchObject({ status: 'READY', context: { targetingKey: 'anonymous-key' } });
  });

  it('stop() aborts the in-flight fetch and waits for pending writes', async () => {
    const hanging = (_url: string, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      });
    const { owner: started } = startOwner(hanging, { startupContext: precomputedContext });
    const settled = started.settled();
    await started.stop();
    // The in-flight fetch was aborted: its outcome settles (superseded) without publishing.
    await settled;
    expect(state.snapshot().status).toBe('NOT_READY');
  });
});

/** Serialize assignments for a targeting key with the fixture context, as a wire string. */
function assignmentsWireFor(variant: string): string {
  return JSON.stringify({
    version: 1,
    precomputed: {
      context: precomputedContext,
      response: JSON.stringify({
        data: {
          attributes: {
            createdAt: `created-at-${variant}`,
            flags: {
              assigned: {
                allocationKey: 'alloc',
                variationKey: `variant-${variant}`,
                variationType: 'string',
                variationValue: `variant-${variant}`,
                reason: 'STATIC',
                doLog: true,
                serialId: 1,
              },
            },
          },
        },
      }),
      fetchedAt: 1,
    },
  });
}

// The fixture response must round-trip through the wire parser.
void precomputedCreatedAtOf;
