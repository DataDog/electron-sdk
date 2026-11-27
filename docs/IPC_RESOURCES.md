# IPC Resources

A renderer that calls `ipcRenderer.invoke` waits for the main process handler to answer. The SDK can report each
handler call as a RUM resource of type `message`, so that a slow or failing handler shows up in the main process view.

> ⚗️ Experimental: the environment variable and the reported fields may change.

## Enabling

Set `DD_ELECTRON_EXPERIMENTAL_IPC_RESOURCES_ENABLED=true` in the main process environment before the instrument entry
loads, for example at launch:

```bash
DD_ELECTRON_EXPERIMENTAL_IPC_RESOURCES_ENABLED=true electron .
```

The instrument entry reads it once, when it loads. Setting it in the main entry's own code is too late with the SDK's
bundler plugins, which load the instrument entry first, and in an ES module, whose imports run first. A packaged app can
set it in a small entry script that the bundler doesn't build, then load its main bundle with `require()` or a dynamic
`import()`.

Once enabled, every handler is wrapped from the moment the instrument entry loads, even before `init()`: an error
created before a handler's first `await` has one more SDK frame in its stack. Otherwise, the SDK doesn't wrap any IPC
handler.

## What is reported

Each call to a handler registered with `handle` or `handleOnce` on `ipcMain`, `webContents.ipc` or `webFrameMain.ipc`
gives a resource with the channel in `resource.url` and the handler's duration. Its `resource.message` has
`role: 'destination'`, `api: 'handle'`, and `is_error`, `true` when the handler throws or rejects. Arguments and return
values are not collected, and the main process doesn't report the handler's error: Electron catches it and passes it to
the renderer.

- **Volume:** a channel that a renderer polls adds one resource per call.
- **Filtering:** `beforeSendRum` gets these resources with `source: 'main'` in its second argument. Return `false` to
  drop a channel's calls, or rename the channel in `resource.url`.
- **Channel names:** Datadog derives the URL facets from `resource.url`: `main:failing-handler` gets `url_scheme: main`
  and `url_path_group: failing-handler`, without its prefix. Group calls by `@resource.url`, and keep identifiers out
  of channel names, since the path group keeps them as they are (`user:get:42` gives `get:42`).

## Not reported

- Calls that start before `init()` resolves.
- Messages sent with `send`, `sendSync` or `postMessage`, and `ServiceWorkerMain.ipc` handlers.
- The renderer side of a call: each resource gets a `resource.message.id` of its own.
