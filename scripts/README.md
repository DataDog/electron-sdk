# Scripts

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
