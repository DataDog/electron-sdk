/**
 * Tracks which IPC call is "currently being handled", so a new call initiated from within a
 * destination handler can inherit that call's ancestry as its own `parent_ids`.
 *
 * This is a synchronous approximation, not a true async-context primitive (`node:async_hooks`'s
 * `AsyncLocalStorage`): the tracked context is restored as soon as the wrapped callback returns
 * *synchronously* — for an async callback, that means right when it returns its pending promise, not
 * when that promise settles. A nested call made after an `await` inside the same handler, or two
 * handlers whose async execution overlaps, will see an empty (or otherwise incorrect) parent chain
 * rather than the real one. Accepted for this prototype: every scenario that actually exists today
 * triggers its nested call synchronously, before any `await`. Deliberately plain, dependency-free
 * JS — no `async_hooks` — so the exact same module works unmodified in both the main process and a
 * (possibly sandboxed) preload script. See ipcParentContext.spec.ts's last test for the documented gap.
 */
interface IpcContext {
  id: string;
  parentIds: string[];
}

let current: IpcContext | undefined;

export function withIpcContext<T>(id: string, parentIds: string[], fn: () => T): T {
  const previous = current;
  current = { id, parentIds };
  try {
    return fn();
  } finally {
    current = previous;
  }
}

export function computeChildParentIds(): string[] {
  return current ? [...current.parentIds, current.id] : [];
}
