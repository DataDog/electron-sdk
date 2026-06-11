export function patchFetchContext(tracer: typeof import('dd-trace').default): void {
  const originalFetch = globalThis.fetch;
  if (!originalFetch) return;

  globalThis.fetch = function (...args: Parameters<typeof fetch>) {
    const span = tracer.scope().active();
    if (span) {
      return tracer.scope().activate(span, () => originalFetch.apply(globalThis, args));
    }
    return originalFetch.apply(globalThis, args);
  } as typeof globalThis.fetch;
}
