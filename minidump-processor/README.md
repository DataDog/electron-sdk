# minidump-processor

WASM crate that wraps [`rust-minidump`](https://github.com/rust-minidump/rust-minidump) for use in the Datadog Electron SDK. Processes `.dmp` crash files into structured JSON (threads, modules, crash info) without HTTP symbol resolution.

The pre-built artifacts in `pkg/` are committed to the repository. Rebuild them when `src/lib.rs` changes by running `yarn build:wasm` from the repo root.

## Prerequisites

```sh
brew install rustup wasm-pack

# rustup is keg-only — add it to your PATH (add to ~/.zshrc to persist)
export PATH="$(brew --prefix rustup)/bin:$PATH"

# Initialize the default Rust toolchain and add the WASM target
rustup default stable
rustup target add wasm32-unknown-unknown
```

## Rebuilding WASM artifacts

```sh
yarn build:wasm
```

Effects:

- Runs `wasm-pack build`,
- Embeds the WASM binary as base64 directly in `pkg/minidump.js`,
- Regenerates `pkg/`

Commit the updated `pkg/` directory.

## Usage (TypeScript)

Import via the wrapper in `src/wasm/`:

```typescript
import { processMinidump } from '../wasm';

const bytes = await fs.readFile('/path/to/crash.dmp');
const result = await processMinidump(bytes);
console.log(result.crash_info.type);
```
