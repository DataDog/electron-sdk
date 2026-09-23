# Scripts

## Directory Structure

```
scripts/
├── *.ts              # Top-level scripts (entry points)
├── lib/              # Shared utilities
│   ├── command.ts    # Shell-injection-safe command runner
│   ├── executionUtils.ts  # runMain, printLog, printError
│   └── filesUtils.ts     # findPackageJsonFiles
└── cli               # Bash commands (cmd_<name> pattern)
```

## Preferences

When adding automation scripts to the project:

1. **Prefer Node.js scripts** over bash scripts for:
   - Complex logic and error handling
   - Cross-platform compatibility
   - TypeScript integration
   - JSON/data processing

2. **Bash scripts belong in `scripts/cli`**:
   - All bash scripts should be implemented as commands in `scripts/cli`
   - Use `cmd_<name>` function pattern for new commands
   - Accessible via `scripts/cli <command>` or `yarn` scripts
   - Example: `scripts/cli build_fork` or `yarn postinstall`

3. **Examples**:
   - ✅ Node.js: `scripts/generate-schema-types.ts` (complex JSON processing)
   - ✅ CLI command: `scripts/cli build_fork` (build automation)
   - ❌ Standalone bash: `scripts/build-fork.sh` (should be in CLI instead)

## Basic TypeScript Scripts Structure

All scripts follow this pattern:

```typescript
import { printLog, runMain } from './lib/executionUtils.ts';
import { command } from './lib/command.ts';

runMain(async () => {
  printLog('Starting task...');

  // Script logic here
  command`yarn build`.run();

  printLog('Task completed.');
});
```

**Key conventions:**

- Use `runMain()` wrapper for proper async handling and error reporting
- Use `printLog()` for console output
- Use the `command` template literal for commands. Both it and the logged-command runner launch Yarn's
  JavaScript entry point through Node on Windows, avoiding `.cmd` execution and shell quoting.
  They use the active Yarn CLI or find Corepack/Yarn beside Node or on `PATH`; macOS/Linux use normal executable lookup.
  Keep the logged-command runner dependency-free because CI uses it before `yarn install`.
- Import with `.ts` extension (required for Node.js ESM)
