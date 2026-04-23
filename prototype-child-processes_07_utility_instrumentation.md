# Utility Process Instrumentation — Error Capture Prototype

Prototype findings for capturing uncaught errors inside Electron utility processes and forwarding them to the main process as RUM error events with full stack traces.

## Goal

When an uncaught exception occurs inside a utility process, the main process currently only sees "exited with code 1" — no error message, no stack trace. This prototype adds error capture with full stack traces, using parentPort piggyback + child.emit interception.

The approach should support future extensions: manual error API (`addError()`), dd-trace span forwarding, and other telemetry from utility processes.

## Architecture

```
Main Process (UtilityProcessCollection)          Utility Process
+--------------------------------------+        +--------------------------------------+
| patchedFork():                       |        | Customer entry file:                 |
|  1. Call original fork()             |        |   require('@datadog/electron-sdk/    |
|  2. Override child.emit('message')   |        |          utility')                   |
|     to intercept __dd messages       |        |   ↳ registers uncaughtException      |
|  3. On __dd msg: emitError()         |        |     + unhandledRejection handlers    |
|                                      |        |                                      |
|  child.emit('message', msg)          |        | On error:                            |
|    ↳ msg.__dd? → handle + swallow    |        |   parentPort.postMessage(            |
|    ↳ else    → original emit     <---+--------+     { __dd: true, type: 'error',     |
|               (customer sees it)     |        |       message, stack })              |
+--------------------------------------+        +--------------------------------------+
```

Error flow: uncaught error in utility process → SDK module catches it → sends `{ __dd: true, type, message, stack }` via `parentPort.postMessage()` → Electron delivers to main process → `child.emit('message')` intercepted → SDK swallows `__dd` message and emits `RawRumError` on the utility process view → EventManager → Assembly → Transport. Customer handlers never see the `__dd` message.

## Injection approaches investigated

### Approach 1: `execArgv` with `--require` — does NOT work

**Hypothesis:** Pass `--require /path/to/preload.cjs` via the `execArgv` option of `utilityProcess.fork()` to transparently load the SDK's error handler before the customer's entry module.

**Test result:** The `--require` flag appears in `process.execArgv` inside the utility process, but the required file never executes.

**Root cause (confirmed at Electron source level):**

Two independent blocking points prevent `--require` from working:

1. **`IsAllowedOption` allowlist** ([`shell/common/node_bindings.cc` L425](https://github.com/electron/electron/blob/main/shell/common/node_bindings.cc)): Electron maintains an explicit allowlist of Node.js flags that are permitted. `--require` is not on it. Only debug/inspect flags, diagnostic flags, and a few others are allowed. V8 flags like `--max-old-space-size` bypass this because V8 processes them directly from the command line before Node.js initialization.

2. **`exec_args` stored but never parsed** ([Node.js `env.cc` L813](https://github.com/nicolo-ribaudo/node/blob/main/src/env.cc)): Even if `--require` made it past the allowlist, Node.js's embedding API stores `exec_args` as `process.execArgv` but never parses them into the options object. When `loadPreloadModules()` calls `getOptionValue('--require')`, it reads from global options which know nothing about per-environment `exec_args`.

**Reference:** [electron/electron#49252](https://github.com/electron/electron/issues/49252) confirms the `IsAllowedOption` mechanism.

**Verdict:** Not viable. This is a deliberate Electron security restriction.

### Approach 2: `NODE_OPTIONS` env var with `--require` — works in dev, blocked in packaged apps

**Hypothesis:** Set `NODE_OPTIONS="--require /path/to/preload.cjs"` in the utility process environment via the `env` fork option.

**Test result:** Works in development (unpackaged Electron). The preload executes, error capture works end-to-end.

**Packaged apps — inconclusive:** When tested against VS Code, a log was observed: `ERROR:electron/shell/common/node_bindings.cc:484] Most NODE_OPTIONs are not supported in packaged apps.` The `SetNodeOptions()` function in `node_bindings.cc` gates `NODE_OPTIONS` processing behind `fuses::IsNodeOptionsEnabled()`, which is typically disabled in packaged apps. However, this error log may have been triggered by unrelated `NODE_OPTIONS` flags already present in the environment, not by our `--require` injection specifically. **We did not isolate the test to confirm that our `--require` flag is the one being rejected.** This needs a dedicated test: set `NODE_OPTIONS="--require /path/to/preload.cjs"` as the _only_ `NODE_OPTIONS` value in a packaged Electron app (e.g., VS Code) and verify whether the preload executes.

**Additional finding — `process.parentPort` timing:** When `--require` runs (via `NODE_OPTIONS` in dev), `process.parentPort` is NOT yet available. It becomes available after Electron's utility process initialization, before the entry module executes. The preload must defer `parentPort` access using `process.nextTick()`.

**Verdict:** Works in dev. Potentially viable for production if `NODE_OPTIONS` with `--require` is not stripped in packaged apps — **needs confirmation with an isolated test against a packaged Electron app.** If confirmed working, this would enable transparent injection without customer code changes.

### Approach 3: Customer imports SDK module — works everywhere (chosen)

**Design:** The customer adds one line at the top of their utility process entry file:

```js
require('@datadog/electron-sdk/utility');
```

The SDK exports this module via `package.json` exports map:

```json
{
  "./utility": {
    "require": "./dist/utility-preload.cjs"
  }
}
```

**How it works:**

1. The customer's `require()` call executes the SDK utility module synchronously, before any other customer code in the entry file.
2. The module registers `process.parentPort.on('message')` to receive the dedicated MessagePort from the main process.
3. The module registers `process.on('uncaughtException')` and `process.on('unhandledRejection')` to capture errors.
4. On the main process side, `UtilityProcessCollection.patchedFork()` creates a `MessageChannelMain` and transfers `port2` to the utility process on the `spawn` event.
5. When an uncaught error occurs, the utility module serializes `{ type: 'error', message, stack }` and sends it via the dedicated port.
6. The main process receives the error on `port1` and emits a `RawRumError` with the full stack trace.

**Customer requirement:** One line of code in each utility process entry file. No other changes needed.

**Tradeoffs:**

- Not transparent — requires customer opt-in per utility process
- But compatible with packaged apps, no security restrictions
- Same pattern scales to manual API and dd-trace forwarding (future)

**Verdict:** Chosen approach. Works in all Electron configurations.

## VS Code compatibility findings

### Port transfer on spawn blocks all parentPort messages

**Bug:** When the SDK transfers a `MessagePortMain` via `child.postMessage({ __dd_port: true }, [port2])` on the `spawn` event, **all subsequent messages stop reaching `process.parentPort`** in the utility process. This was confirmed in VS Code where three utility processes (Extension Host, Shared Process, File Watcher) all received zero messages with the SDK enabled.

**Root cause:** Transferring a `MessagePortMain` as a transferable via `child.postMessage()` during the `spawn` event appears to corrupt or lock Electron's internal message channel for the utility process. The exact Chromium-level mechanism is unclear, but the effect is reproducible: no messages reach `parentPort`, not even messages sent by VS Code's own `child.postMessage()` calls after fork.

**Attempted fix 1 — pull-based handshake (rejected):** Instead of pushing the port on spawn, we tried a pull-based protocol where the utility process sends `{ __dd_ready: true }` via `parentPort.postMessage()` and the main process responds with the port transfer. This avoided the spawn-time corruption but introduced two new problems (see below).

### Registering parentPort.on('message') drains the message buffer

**Bug:** Electron's `parentPort` buffers incoming messages until the first `'message'` listener is registered (similar to `MessagePort.start()`). The SDK utility module runs at `require()` time (before the customer's async entry point loads), so its `parentPort.on('message')` registration drains the buffer before the application's handlers are set up.

In VS Code, the bootstrap sequence is:

1. `require('@datadog/electron-sdk/utility')` — SDK registers `parentPort.on('message')` → buffer drains
2. `await bootstrapESM()` — event loop yields, buffered messages delivered to SDK handler
3. `await import(entrypoint)` — app module loads
4. App registers `parentPort.on('message')` — too late, messages already consumed

Verified by progressively disabling parts of the preload: an empty function body works; adding only `parentPort.on('message')` breaks the Extension Host (10s timeout); deferring the listener by 3s via `setTimeout` works but is fragile.

### Overriding child.on/child.once breaks message delivery

**Bug:** Wrapping `child.on('message')` and `child.once('message')` on the main process side to filter SDK-internal messages (`__dd_ready`) caused **zero messages** to reach `parentPort` in any utility process. The exact cause is unclear — Electron internals likely depend on the original prototype `on`/`once` methods for message dispatching.

### Solution — parentPort piggyback + child.emit interception (chosen)

**Validated with VS Code.** The approach avoids all three pitfalls:

**Utility process side — send only, no listener:**

- Errors are sent via `process.parentPort.postMessage({ __dd: true, type: 'error', message, stack })`
- **No** `parentPort.on('message')` listener is registered → no buffer drain
- No MessagePort transfer needed

**Main process side — child.emit interception:**

- Override `child.emit` (not `child.on`/`child.once`) to intercept `'message'` events
- Messages with `__dd: true` are swallowed before reaching customer handlers
- Non-SDK messages pass through to the original `emit` untouched

```
Electron dispatches message → child.emit('message', msg)
  → SDK checks msg.__dd
  → If __dd: handle internally (emit RawRumError), return true (swallowed)
  → If not: call original emit → customer handlers see the message
```

**Why `child.emit` is safe to override while `child.on`/`child.once` are not:**

Electron's `UtilityProcess` is a C++ object exposed to JavaScript as a Node.js `EventEmitter`. The message delivery path is:

1. Chromium's IPC layer receives a message from the utility process
2. Electron's C++ code calls into JavaScript to dispatch the event
3. This triggers `child.emit('message', msg)` on the JS side
4. `emit` iterates the registered listeners and calls each one

Overriding `on`/`once` (step 4's registration) breaks Electron because the C++ binding may use the original prototype methods to register internal handlers during object construction — before our override runs. When we replace `on`/`once` on the instance, these internal registrations may be affected or the C++ side may hold a reference to the original methods.

Overriding `emit` (step 3's dispatch) is safe because:

- It's called _after_ all internal setup is complete
- It's the final JavaScript entry point before listeners fire
- We call the original `emit` for non-SDK messages, so all listeners (including any internal ones) still receive their events
- We only suppress `emit` for `__dd` messages, which no internal code expects

In effect, `emit` interception is a read-only filter on the output side of the event pipeline, while `on`/`once` overrides modify the input side where Electron's internals also operate.

**Other benefits:**

- No `parentPort` listener in the utility process — no buffer drain
- No MessagePort transfer — no channel corruption
- SDK messages are invisible to customer handlers — no leak

## Build pipeline findings

### Rollup emits `require('electron')` from ambient type references

The utility preload source uses `process.parentPort` which is typed by Electron's ambient type augmentation of `NodeJS.Process`. Even though the source never imports `electron`, rollup detects the type reference and emits `require('electron')` in the CJS output.

Inside a utility process, this `require('electron')` call resolves to Electron's npm helper package (which reads `path.txt` to find the binary) rather than the Electron runtime. This crashes the utility process silently.

**Fix:** A custom rollup plugin (`strip-electron-require`) removes the side-effect-only `require('electron')` from the output:

```js
{
  name: 'strip-electron-require',
  renderChunk(code) {
    return code.replace(/require\('electron'\);\n?/g, '');
  },
}
```

The utility preload rollup entry also uses `external: ['electron']` to prevent rollup from bundling the npm `electron` package (which would be even worse — it includes the binary path resolution code).

## Open questions

- **`NODE_OPTIONS` in packaged apps:** The rejection of `NODE_OPTIONS --require` in packaged Electron apps was observed via an error log in VS Code, but the test was not isolated — the log may have been triggered by unrelated `NODE_OPTIONS` flags already in the environment. A dedicated test with `NODE_OPTIONS="--require /path/to/preload.cjs"` as the only value in a packaged app is needed. If confirmed working, this would enable transparent injection without customer code changes.
- **Error deduplication:** When an uncaught exception crashes the utility process, two error events are emitted: one from the parentPort piggyback (with stack trace) and one from the `exit` handler ("exited with code N", without stack trace). The piggyback error arrives first. Production implementation should deduplicate these.
- **`child.emit` override durability:** The `child.emit` interception works with VS Code (Electron 39.8.8) but relies on Electron dispatching messages via `emit('message', ...)`. If a future Electron version changes this dispatch mechanism, the interception would break silently (SDK messages would leak to customer handlers). Production implementation should include a test that validates the interception still works.
- **Unhandled rejections:** The current prototype forwards them but the process continues running. Should the SDK track these differently (e.g., different `handling` value)?
- **Future bidirectional communication:** The current approach is one-way (utility → main). If we need the main process to push config or commands to the utility process (e.g., session ID, sample rate), we would need a return channel. Options: (a) extend parentPort piggyback to be bidirectional (main sends `{ __dd: true, ... }` via `child.postMessage()`, utility process filters with its own emit-style interception on `parentPort`), or (b) fall back to a dedicated IPC socket for high-throughput scenarios like dd-trace span forwarding.
