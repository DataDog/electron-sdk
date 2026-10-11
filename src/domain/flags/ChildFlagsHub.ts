import { MessageChannel, type MessagePort } from 'node:worker_threads';
import * as electron from 'electron';
import type { Subscription } from '@datadog/browser-core';
import { isIndexableObject } from '@datadog/js-core/util';
import { display } from '../../tools/display';
import { addError as addTelemetryError, callMonitored, monitor } from '../telemetry';
import { normalizeFlagsContext } from '../../common/flags/flagsContext';
import { minimalFlagsSnapshot } from '../../common/flags/flagsHolder';
import {
  contextResponseMessage,
  MAX_CONTEXT_REQUEST_LENGTH,
  snapshotMessage,
  type ChildMessage,
  type ContextRequestMessage,
} from '../../common/flags/childProtocol';
import {
  createFramesEndpoint,
  createPortEndpoint,
  type FlagsEndpoint,
  type FlagsFramesEndpoint,
} from '../../child/flags/childEndpoints';
import type { FlagsSnapshot, FlatContext } from '../../common/flags/types';
import type { FlagsState } from './FlagsState';
import { publishedSnapshot } from './SnapshotPublisher';
import type { EvaluationBatchIntake } from './EvaluationBatchIntake';
import type { AnonymousKeyStore } from './AnonymousKeyStore';

/** At most this many channels are open at once; the oldest is closed beyond that (D22). */
export const MAX_OPEN_CHANNELS = 100;

/**
 * Decide whether a child's context request is applied. Receives the normalized context
 * and the channel name; return `false` to reject.
 */
export type ContextRequestFilter = (requested: FlatContext, channel: { name?: string }) => boolean;

/** A process whose `'exit'` closes the channel (a `ChildProcess`, a `UtilityProcess`). */
export interface ExitOwner {
  once(event: 'exit', listener: () => void): unknown;
  removeListener(event: 'exit', listener: () => void): unknown;
}

interface ChannelBase {
  /** Names the channel in warnings and for `onContextRequest`; opening the same name again replaces it. */
  name?: string;
  /** Filter child context requests (accepted by default, D20). */
  onContextRequest?: ContextRequestFilter;
}

/** A channel over a private, SDK-owned port: transfer `port` to the child once. */
export interface FlagsPortChannel<P> {
  readonly port: P;
  readonly closed: boolean;
  close(): void;
}

/** A channel over frames the app routes through its own `child_process` protocol. */
export interface FlagsFramesChannel {
  /** Hand a frame from the child to the SDK; anything that is not an SDK frame is ignored. */
  receive(frame: unknown): void;
  readonly closed: boolean;
  close(): void;
}

export type OpenFlagsChannelOptions =
  | (ChannelBase & { kind: 'worker' })
  | (ChannelBase & { kind: 'utility' })
  | (ChannelBase & { kind: 'frames'; send: (frame: string) => void; owner?: ExitOwner });

/** What startFeatureFlags provides once the controller exists. */
export interface FlagsChildrenLink {
  state: FlagsState;
  intake: EvaluationBatchIntake;
  keyStore: AnonymousKeyStore;
  /**
   * Apply a normalized context request. In precomputed mode this fetches the assignments
   * for the context and resolves once they are applied (§11.3); the context response is
   * delayed accordingly. Defaults to a synchronous `state.applyContextUpdate`.
   */
  applyContextChange?: (context: FlatContext) => void | Promise<void>;
}

interface ChildrenHolder {
  channels: ChildChannel[];
  link?: FlagsChildrenLink;
  disabled?: boolean;
}

const CHILDREN_HOLDER = Symbol.for('@datadog/electron-sdk:flagsChildren');

function getChildrenHolder(): ChildrenHolder {
  const globals = globalThis as Record<symbol, ChildrenHolder | undefined>;
  return (globals[CHILDREN_HOLDER] ??= { channels: [] });
}

function currentSnapshot(holder: ChildrenHolder): FlagsSnapshot {
  if (holder.link !== undefined) return publishedSnapshot(holder.link.state.snapshot());
  return minimalFlagsSnapshot(holder.disabled === true ? 'DISABLED' : 'NOT_READY');
}

/**
 * Main's end of one spawned-process channel (D17–D22): pushes snapshots on open, on
 * `hello` and on every newer revision; hands evaluation batches to the shared intake; and
 * answers context requests. It never listens on an app-owned object except
 * `owner.once('exit')`, removed on close.
 */
class ChildChannel {
  private lastSentKey: string | undefined;
  private onOwnerExit: (() => void) | undefined;
  closed = false;

  constructor(
    private readonly endpoint: FlagsEndpoint,
    readonly name: string | undefined,
    private readonly onContextRequest: ContextRequestFilter | undefined,
    private readonly owner: ExitOwner | undefined,
    private readonly onClosed: (channel: ChildChannel) => void
  ) {}

  start(): void {
    this.endpoint.setHandler(
      monitor((message: ChildMessage) => this.onMessage(message)),
      monitor(() => this.close())
    );
    if (this.owner !== undefined) {
      this.onOwnerExit = monitor(() => this.close());
      this.owner.once('exit', this.onOwnerExit);
    }
    this.push(true);
  }

  /** Push the current snapshot; unless forced, only when its revision changed. */
  push(force = false): void {
    if (this.closed) return;
    const snapshot = currentSnapshot(getChildrenHolder());
    const key = `${snapshot.status}:${snapshot.revision}`;
    if (!force && key === this.lastSentKey) return;
    this.lastSentKey = key;
    this.endpoint.send(snapshotMessage(JSON.stringify(snapshot)));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.owner !== undefined && this.onOwnerExit !== undefined) {
      this.owner.removeListener('exit', this.onOwnerExit);
    }
    this.endpoint.close();
    this.onClosed(this);
  }

  private onMessage(message: ChildMessage): void {
    if (this.closed) return;
    switch (message.type) {
      case 'hello':
        this.push(true);
        break;
      case 'evaluations':
        // Before init no record can be exposure-eligible: nothing to forward.
        getChildrenHolder().link?.intake.receive(message.payload, 'child');
        break;
      case 'context-request': {
        const reply = callMonitored(() => this.answerContextRequest(message));
        if (reply !== undefined && typeof (reply as Promise<ChildMessage>).then === 'function') {
          // Precomputed mode: the response lands once the assignments for the requested
          // context are applied (§11.3).
          void (reply as Promise<ChildMessage>).then(
            (response) => this.endpoint.send(response),
            (error: unknown) => {
              addTelemetryError(error);
            }
          );
        } else if (reply !== undefined) {
          this.endpoint.send(reply as ChildMessage);
        }
        break;
      }
      default:
        // Main-to-child message types are ignored on main's end.
        break;
    }
  }

  private answerContextRequest(message: ContextRequestMessage): ChildMessage | Promise<ChildMessage> {
    const link = getChildrenHolder().link;
    if (link === undefined) {
      return contextResponseMessage(message.id, false);
    }
    if (message.payload.length > MAX_CONTEXT_REQUEST_LENGTH) {
      link.intake.reportDropped(1);
      return contextResponseMessage(message.id, false);
    }
    let requested: unknown;
    try {
      requested = JSON.parse(message.payload);
    } catch {
      link.intake.reportDropped(1);
      return contextResponseMessage(message.id, false);
    }
    if (!isIndexableObject(requested) || Array.isArray(requested)) {
      link.intake.reportDropped(1);
      return contextResponseMessage(message.id, false);
    }
    const { context, droppedKeys } = normalizeFlagsContext(requested, link.keyStore.anonymousKey);
    if (droppedKeys.length > 0) {
      display.warn(`Dropped feature flags context attributes requested by a child process: ${droppedKeys.join(', ')}`);
    }
    if (this.onContextRequest !== undefined) {
      const name = this.name;
      const accepted = callMonitored(() => this.onContextRequest!(context, name !== undefined ? { name } : {}));
      if (accepted === false || accepted === undefined) {
        return contextResponseMessage(message.id, false);
      }
    }
    const state = link.state;
    if (JSON.stringify(state.snapshot().context) !== JSON.stringify(context)) {
      // Last writer wins with main's OpenFeature.setContext (D20). In precomputed mode the
      // reply is sent once the assignments for the requested context are applied.
      const applied =
        link.applyContextChange !== undefined ? link.applyContextChange(context) : state.applyContextUpdate(context);
      if (isPromiseLike(applied)) {
        return applied.then(
          () => contextResponseMessage(message.id, true, state.snapshot().contextRevision),
          () => contextResponseMessage(message.id, false)
        );
      }
    }
    return contextResponseMessage(message.id, true, state.snapshot().contextRevision);
  }
}

function registerChannel(channel: ChildChannel): void {
  const holder = getChildrenHolder();
  if (channel.name !== undefined) {
    for (const existing of holder.channels.filter((candidate) => candidate.name === channel.name)) {
      existing.close();
    }
  }
  holder.channels.push(channel);
  while (holder.channels.length > MAX_OPEN_CHANNELS) {
    const oldest = holder.channels[0];
    display.warn(
      `More than ${MAX_OPEN_CHANNELS} feature flags channels are open; closing the oldest${
        oldest.name !== undefined ? ` ("${oldest.name}")` : ''
      }.`
    );
    oldest.close();
  }
}

function removeChannel(channel: ChildChannel): void {
  const holder = getChildrenHolder();
  holder.channels = holder.channels.filter((candidate) => candidate !== channel);
}

/**
 * Open a feature flags channel to a spawned process. Main keeps the configuration and the
 * evaluation context; the child connects with `connectFlags` from
 * `@datadog/electron-sdk/child`, evaluates locally from the snapshots pushed here, and
 * reports evaluations back (attributed to the main process).
 *
 * The SDK never listens on, refs or writes to a channel the app owns:
 * - `kind: 'worker'` returns a private `worker_threads` `MessagePort` to transfer in
 *   `workerData`;
 * - `kind: 'utility'` returns a private `MessagePortMain` to transfer with the app's own
 *   first `utilityProcess.postMessage`;
 * - `kind: 'frames'` (for `child_process.fork`, which cannot transfer ports) writes string
 *   frames through `send`; route the child's frames to `receive`. With `owner`, the channel
 *   closes itself when that process exits.
 *
 * Connection order does not matter: the channel pushes the current snapshot as soon as it
 * opens, answers the child's `hello` with the current snapshot, and pushes every newer
 * revision (rules or context), so the child may connect before or after the channel opens,
 * and before or after main's flags are ready.
 *
 * Works before `init()`: channels answer `NOT_READY` until the feature flags controller
 * starts, and `DISABLED` when `init()` ran without `featureFlags`. `kind: 'utility'` needs
 * Electron's `MessageChannelMain`, resolved only when such a channel is opened. Port channels close
 * when the peer port closes. Opening a channel with an existing `name` closes the previous
 * one.
 *
 * @example
 * ```ts
 * import { fork } from 'node:child_process'
 * import { Worker } from 'node:worker_threads'
 * import { openFlagsChannel } from '@datadog/electron-sdk'
 *
 * const child = fork(entry, [], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
 * const flags = openFlagsChannel({
 *   kind: 'frames',
 *   name: 'server-host',
 *   owner: child,
 *   send: (frame) => child.send({ type: 'dd-flags', frame }, () => {}),
 * })
 * child.on('message', (msg) => (msg.type === 'dd-flags' ? flags.receive(msg.frame) : handleAppMessage(msg)))
 *
 * const hash = openFlagsChannel({ kind: 'worker', name: 'hash' })
 * new Worker(hashWorkerPath, { workerData: { flagsPort: hash.port }, transferList: [hash.port] })
 * ```
 */
export function openFlagsChannel(options: ChannelBase & { kind: 'worker' }): FlagsPortChannel<MessagePort>;
export function openFlagsChannel(
  options: ChannelBase & { kind: 'utility' }
): FlagsPortChannel<Electron.MessagePortMain>;
export function openFlagsChannel(
  options: ChannelBase & { kind: 'frames'; send: (frame: string) => void; owner?: ExitOwner }
): FlagsFramesChannel;
export function openFlagsChannel(
  options: OpenFlagsChannelOptions
): FlagsPortChannel<MessagePort> | FlagsPortChannel<Electron.MessagePortMain> | FlagsFramesChannel {
  const label = options.name ?? options.kind;
  const onContextRequest = options.onContextRequest;
  if (options.kind === 'frames') {
    const endpoint: FlagsFramesEndpoint = createFramesEndpoint(options.send, label);
    const channel = new ChildChannel(endpoint, options.name, onContextRequest, options.owner, removeChannel);
    registerChannel(channel);
    channel.start();
    return {
      receive: (frame: unknown) => callMonitored(() => endpoint.receive(frame)),
      get closed() {
        return channel.closed;
      },
      close: () => channel.close(),
    };
  }
  const { port1, port2 } = options.kind === 'worker' ? new MessageChannel() : new (resolveMessageChannelMain())();
  const channel = new ChildChannel(
    createPortEndpoint(port1, label),
    options.name,
    onContextRequest,
    undefined,
    removeChannel
  );
  registerChannel(channel);
  channel.start();
  return {
    port: port2 as MessagePort & Electron.MessagePortMain,
    get closed() {
      return channel.closed;
    },
    close: () => channel.close(),
  };
}

/**
 * Link the open channels to the feature flags controller (called by startFeatureFlags):
 * every channel receives the real snapshot now and on every newer revision. Returns the
 * unlink function, which closes every channel (controller stop) unless `closeChannels` is
 * false (re-init and startup rollback keep them for the next link or `DISABLED`).
 */
export function linkFlagsChildren(link: FlagsChildrenLink): (options?: { closeChannels?: boolean }) => void {
  const holder = getChildrenHolder();
  holder.link = link;
  holder.disabled = false;
  const subscription: Subscription = link.state.subscribe(() => {
    for (const channel of [...holder.channels]) channel.push();
  });
  for (const channel of [...holder.channels]) channel.push();
  return ({ closeChannels = true } = {}) => {
    subscription.unsubscribe();
    if (holder.link === link) holder.link = undefined;
    if (closeChannels) closeAllFlagsChannels();
  };
}

/** `init()` ran without `featureFlags`: channels answer `DISABLED`. */
export function disableFlagsChildren(): void {
  const holder = getChildrenHolder();
  holder.disabled = true;
  for (const channel of [...holder.channels]) channel.push();
}

/** Close every open channel. */
export function closeAllFlagsChannels(): void {
  for (const channel of [...getChildrenHolder().channels]) channel.close();
}

/** Internal: the number of open channels. */
export function openFlagsChannelCount(): number {
  return getChildrenHolder().channels.length;
}

/**
 * `MessageChannelMain` is resolved only when a utility channel is opened (F2), through the
 * `electron` namespace rather than a named import: the main bundle must load in contexts whose
 * `electron` module lacks it, and only `kind: 'utility'` needs it.
 */
function resolveMessageChannelMain(): typeof Electron.MessageChannelMain {
  let messageChannelMain: unknown;
  try {
    messageChannelMain = (electron as { MessageChannelMain?: unknown }).MessageChannelMain;
  } catch {
    // Some module shims throw on a missing export instead of returning undefined.
  }
  if (typeof messageChannelMain !== 'function') {
    throw new Error("openFlagsChannel({ kind: 'utility' }) needs Electron's MessageChannelMain (main process only).");
  }
  return messageChannelMain as typeof Electron.MessageChannelMain;
}

/** Whether a value is thenable, so a context change can resolve asynchronously (§11.3). */
function isPromiseLike(value: unknown): value is Promise<void> {
  return typeof value === 'object' && value !== null && typeof (value as Promise<void>).then === 'function';
}
