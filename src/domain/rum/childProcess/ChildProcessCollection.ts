import type { ChildProcess, ExecFileException, SpawnSyncReturns } from 'node:child_process';

// Use require() to get the real module object (not a Rollup namespace wrapper)
// so that Object.defineProperty patches are visible to all consumers.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const childProcessModule = require('node:child_process') as typeof import('node:child_process');
import { elapsed, generateUUID, type TimeStamp, timeStampNow, toServerDuration } from '@datadog/browser-core';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
import type { RawRumResource } from '../rawRumData.types';

// Commands spawned by the SDK itself that should not be instrumented
const SELF_INSTRUMENTATION_COMMANDS = ['sw_vers'];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyFunction = (...args: any[]) => any;

/**
 * Reentrant guard: when exec/execFile call spawn internally, we skip
 * the spawn instrumentation to avoid duplicate resource events.
 */
let insideHigherLevelCall = false;

/**
 * Collect child_process spawn/exec/execFile calls as RUM resource events.
 *
 * Each completed child process produces a resource with:
 * - type: "native"
 * - url: "child_process://{command}"
 * - duration: time from invocation to completion
 * - status_code: exit code (0 = success, -1 for errors like ENOENT/timeout)
 * - context: args, shell, cwd (temporary until schema extension)
 */
export class ChildProcessCollection {
  private readonly originals = {
    spawn: childProcessModule.spawn,
    exec: childProcessModule.exec,
    execFile: childProcessModule.execFile,
    spawnSync: childProcessModule.spawnSync,
    execSync: childProcessModule.execSync,
    execFileSync: childProcessModule.execFileSync,
  };

  constructor(private readonly eventManager: EventManager) {
    this.patchSpawn();
    this.patchExec();
    this.patchExecFile();
    this.patchSpawnSync();
    this.patchExecSync();
    this.patchExecFileSync();
  }

  stop(): void {
    Object.defineProperty(childProcessModule, 'spawn', { value: this.originals.spawn, writable: true });
    Object.defineProperty(childProcessModule, 'exec', { value: this.originals.exec, writable: true });
    Object.defineProperty(childProcessModule, 'execFile', { value: this.originals.execFile, writable: true });
    Object.defineProperty(childProcessModule, 'spawnSync', { value: this.originals.spawnSync, writable: true });
    Object.defineProperty(childProcessModule, 'execSync', { value: this.originals.execSync, writable: true });
    Object.defineProperty(childProcessModule, 'execFileSync', { value: this.originals.execFileSync, writable: true });
  }

  private patchSpawn(): void {
    const original = this.originals.spawn as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'spawn', {
      value: function patchedSpawn(command: string, ...rest: unknown[]): ChildProcess {
        const startTime = timeStampNow();
        const child = original.apply(childProcessModule, [command, ...rest]) as ChildProcess;

        if (!isSelfInstrumentation(command) && !insideHigherLevelCall) {
          let emitted = false;
          child.on('close', (code: number | null, signal: string | null) => {
            if (emitted) return;
            emitted = true;
            emitResource(command, startTime, code ?? (signal ? -1 : 0), extractArgs(rest), extractSpawnOptions(rest));
          });
          child.on('error', (err: NodeJS.ErrnoException) => {
            if (emitted) return;
            emitted = true;
            emitResource(command, startTime, -1, extractArgs(rest), extractSpawnOptions(rest), err);
          });
        }

        return child;
      },
      writable: true,
    });
  }

  private patchExec(): void {
    const original = this.originals.exec as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'exec', {
      value: function patchedExec(command: string, ...rest: unknown[]): ChildProcess {
        const startTime = timeStampNow();

        // Wrap the callback if provided
        const lastArg = rest[rest.length - 1];
        if (typeof lastArg === 'function') {
          const originalCallback = lastArg as (error: ExecFileException | null, stdout: string, stderr: string) => void;
          rest[rest.length - 1] = (error: ExecFileException | null, stdout: string, stderr: string) => {
            if (!isSelfInstrumentation(command)) {
              const code = error ? ((error.code as number | undefined) ?? -1) : 0;
              emitResource(
                command,
                startTime,
                typeof code === 'number' ? code : -1,
                undefined,
                undefined,
                error ?? undefined
              );
            }
            originalCallback(error, stdout, stderr);
          };
        }

        insideHigherLevelCall = true;
        const child = original.apply(childProcessModule, [command, ...rest]) as ChildProcess;
        insideHigherLevelCall = false;

        // If no callback was provided, listen for close/error
        if (typeof lastArg !== 'function' && !isSelfInstrumentation(command)) {
          let emitted = false;
          child.on('close', (code: number | null) => {
            if (emitted) return;
            emitted = true;
            emitResource(command, startTime, code ?? 0);
          });
          child.on('error', (err: NodeJS.ErrnoException) => {
            if (emitted) return;
            emitted = true;
            emitResource(command, startTime, -1, undefined, undefined, err);
          });
        }

        return child;
      },
      writable: true,
    });
  }

  private patchExecFile(): void {
    const original = this.originals.execFile as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'execFile', {
      value: function patchedExecFile(file: string, ...rest: unknown[]): ChildProcess {
        // Skip if called from within exec (which already instruments)
        if (insideHigherLevelCall) {
          return original.apply(childProcessModule, [file, ...rest]) as ChildProcess;
        }

        const startTime = timeStampNow();

        const lastArg = rest[rest.length - 1];
        if (typeof lastArg === 'function') {
          const originalCallback = lastArg as (error: ExecFileException | null, stdout: string, stderr: string) => void;
          rest[rest.length - 1] = (error: ExecFileException | null, stdout: string, stderr: string) => {
            if (!isSelfInstrumentation(file)) {
              const code = error ? ((error.code as number | undefined) ?? -1) : 0;
              emitResource(
                file,
                startTime,
                typeof code === 'number' ? code : -1,
                extractArgs(rest),
                undefined,
                error ?? undefined
              );
            }
            originalCallback(error, stdout, stderr);
          };
        }

        insideHigherLevelCall = true;
        const child = original.apply(childProcessModule, [file, ...rest]) as ChildProcess;
        insideHigherLevelCall = false;

        if (typeof lastArg !== 'function' && !isSelfInstrumentation(file)) {
          let emitted = false;
          child.on('close', (code: number | null) => {
            if (emitted) return;
            emitted = true;
            emitResource(file, startTime, code ?? 0, extractArgs(rest));
          });
          child.on('error', (err: NodeJS.ErrnoException) => {
            if (emitted) return;
            emitted = true;
            emitResource(file, startTime, -1, extractArgs(rest), undefined, err);
          });
        }

        return child;
      },
      writable: true,
    });
  }

  private patchSpawnSync(): void {
    const original = this.originals.spawnSync as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'spawnSync', {
      value: function patchedSpawnSync(command: string, ...rest: unknown[]): SpawnSyncReturns<Buffer> {
        const startTime = timeStampNow();
        const result = original.apply(childProcessModule, [command, ...rest]) as SpawnSyncReturns<Buffer>;

        if (!isSelfInstrumentation(command)) {
          const code = result.status ?? (result.error ? -1 : 0);
          emitResource(command, startTime, code, extractArgs(rest), extractSpawnOptions(rest), result.error);
        }

        return result;
      },
      writable: true,
    });
  }

  private patchExecSync(): void {
    const original = this.originals.execSync as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'execSync', {
      value: function patchedExecSync(command: string, ...rest: unknown[]): Buffer | string {
        const startTime = timeStampNow();
        try {
          const result = original.apply(childProcessModule, [command, ...rest]) as Buffer | string;
          if (!isSelfInstrumentation(command)) {
            emitResource(command, startTime, 0);
          }
          return result;
        } catch (error) {
          if (!isSelfInstrumentation(command)) {
            const code = (error as { status?: number }).status ?? -1;
            emitResource(command, startTime, code, undefined, undefined, error as Error);
          }
          throw error;
        }
      },
      writable: true,
    });
  }

  private patchExecFileSync(): void {
    const original = this.originals.execFileSync as AnyFunction;
    const emitResource = this.emitResource.bind(this);

    Object.defineProperty(childProcessModule, 'execFileSync', {
      value: function patchedExecFileSync(file: string, ...rest: unknown[]): Buffer | string {
        const startTime = timeStampNow();
        try {
          const result = original.apply(childProcessModule, [file, ...rest]) as Buffer | string;
          if (!isSelfInstrumentation(file)) {
            emitResource(file, startTime, 0, extractArgs(rest));
          }
          return result;
        } catch (error) {
          if (!isSelfInstrumentation(file)) {
            const code = (error as { status?: number }).status ?? -1;
            emitResource(file, startTime, code, extractArgs(rest), undefined, error as Error);
          }
          throw error;
        }
      },
      writable: true,
    });
  }

  private emitResource(
    command: string,
    startTime: TimeStamp,
    statusCode: number,
    args?: string[],
    options?: { shell?: boolean; cwd?: string },
    error?: Error
  ): void {
    const endTime = timeStampNow();

    const context: Record<string, unknown> = {};
    if (args?.length) context.args = args;
    if (options?.shell !== undefined) context.shell = options.shell;
    if (options?.cwd) context.cwd = options.cwd;
    if (error) {
      context.error_message = error.message;
      context.error_code = (error as NodeJS.ErrnoException).code;
    }

    const resourceEvent: RawRumResource = {
      type: 'resource',
      date: startTime,
      resource: {
        id: generateUUID(),
        type: 'native',
        url: `child_process://${command}`,
        duration: toServerDuration(elapsed(startTime, endTime)),
        status_code: statusCode,
      },
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      source: EventSource.MAIN,
      format: EventFormat.RUM,
      data: resourceEvent,
      startTime,
    });
  }
}

function isSelfInstrumentation(command: string): boolean {
  return SELF_INSTRUMENTATION_COMMANDS.some((cmd) => command === cmd || command.endsWith(`/${cmd}`));
}

function extractArgs(rest: unknown[]): string[] | undefined {
  const first = rest[0];
  return Array.isArray(first) ? (first as string[]) : undefined;
}

function extractSpawnOptions(rest: unknown[]): { shell?: boolean; cwd?: string } | undefined {
  for (const arg of rest) {
    if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
      const opts = arg as Record<string, unknown>;
      return {
        shell: typeof opts.shell === 'boolean' ? opts.shell : undefined,
        cwd: typeof opts.cwd === 'string' ? opts.cwd : undefined,
      };
    }
  }
  return undefined;
}
