import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { generateUUID, setTimeout, type TimeStamp } from '@datadog/browser-core';
import { app, crashReporter } from 'electron';
import { EventFormat, EventKind, EventManager, EventSource } from '../../../event';
// TODO: static import causes WASM compilation at module scope. A dynamic import() inside
// processCrashFiles would defer this cost. Needs measuring to determine if worth the complexity.
import { processMinidump, type CrashReport } from '../../../wasm';
import type { RawRumError } from '../rawRumData.types';
import type { RumErrorEvent } from '../rumEvent.types';
import { displayError, displayInfo } from '../../../tools/display';
import { addError } from '../../telemetry';

/**
 * Collect RUM error events for native crashes.
 * - Electron crashReporter store .dmp files on crashes
 * - At startup:
 *   - scans crash dump directory for .dmp files recursively
 *   - processes each sequentially through the WASM minidump-processor
 *   - emits RUM error events
 */
export class CrashCollection {
  private constructor(private readonly eventManager: EventManager) {}

  static start(eventManager: EventManager): CrashCollection {
    crashReporter.start({ uploadToServer: false, ignoreSystemCrashHandler: true });
    const collection = new CrashCollection(eventManager);
    // process crash files in next tick to avoid blocking app startup
    // TODO(RUM-15046): wait for app to be stable
    setTimeout(() => void collection.processCrashFiles(), 0);
    return collection;
  }

  private async processCrashFiles(): Promise<void> {
    const crashDumpsPath = app.getPath('crashDumps');
    const dmpFiles = await getFilesRecursive(crashDumpsPath, '.dmp');

    const hasFileToProcess = dmpFiles.length > 0;

    if (hasFileToProcess) {
      displayInfo(`${dmpFiles.length} crash dumps to process`);
    }

    for (const filePath of dmpFiles) {
      try {
        const fileStat = await fs.stat(filePath);
        // birthtimeMs can be 0 on Linux (ext4), fall back to mtimeMs
        const crashTime = (fileStat.birthtimeMs || fileStat.mtimeMs) as TimeStamp;
        const bytes = new Uint8Array(await fs.readFile(filePath));
        const crashReport = await processMinidump(bytes);

        this.eventManager.notify({
          kind: EventKind.RAW,
          source: EventSource.MAIN,
          format: EventFormat.RUM,
          data: buildCrashErrorEvent(crashReport, crashTime),
          startTime: crashTime,
        });

        await fs.unlink(filePath);
      } catch (error) {
        addError(error);
        displayError('Failed to process crash dump:', filePath, error);
      }
    }
    if (hasFileToProcess) {
      displayInfo(`Crash dump processing done.`);
    }
  }
}

/**
 * Format a memory address as a 64-bit hexadecimal string (16 hex digits with 0x prefix).
 * Example: '0x7fff5fc01000' → '0x00007fff5fc01000'
 */
function formatAddress64(address: string | undefined): string | undefined {
  if (!address) {
    return undefined;
  }
  const hexValue = address.toLowerCase().replace(/^0x/, '');
  return `0x${hexValue.padStart(16, '0')}`;
}

/**
 * Calculate max address (base + size) using BigInt for 64-bit safe arithmetic.
 */
function calculateMaxAddress(baseAddress: string | undefined, size: number | undefined): string | undefined {
  if (!baseAddress || !size) {
    return undefined;
  }
  const hexValue = baseAddress.toLowerCase().replace(/^0x/, '');
  const maxAddressBigInt = BigInt(`0x${hexValue}`) + BigInt(size);
  return formatAddress64(`0x${maxAddressBigInt.toString(16)}`);
}

function buildCrashErrorEvent(crashReport: CrashReport, crashTime: TimeStamp): RawRumError {
  const threads = formatThreads(crashReport);
  const crashedThread = threads.find((t) => t.crashed);

  return {
    date: crashTime,
    type: 'error',
    error: {
      id: generateUUID(),
      message: 'Application crashed',
      source: 'source',
      handling: 'unhandled',
      is_crash: true,
      category: 'Exception',
      type: crashReport.crash_info.type,
      was_truncated: false,
      meta: {
        code_type: crashReport.system_info.cpu,
        process: app.getName(),
        exception_type: crashReport.crash_info.type,
      },
      source_type: crashReport.system_info.os as RumErrorEvent['error']['source_type'],
      stack: crashedThread?.stack,
      threads,
      binary_images: formatBinaryImages(crashReport),
    },
  };
}

/**
 * Format a thread's frames into a stack trace string.
 * Each line: `{threadId}  {moduleName} {instruction} {baseAddress} + {decimalOffset}`
 * Base address is looked up from modules, with a BigInt fallback from instruction - offset.
 */
function formatFrameStack(
  frames: CrashReport['threads'][number]['frames'],
  threadId: number,
  modules: CrashReport['modules']
): string {
  return frames
    .map((frame) => {
      const moduleName = frame.module ? path.basename(frame.module) : '???';

      let baseAddress: string | undefined = modules.find((m) => m.code_file === frame.module)?.base_address;

      if (!baseAddress && frame.instruction && frame.module_offset) {
        try {
          const instructionAddr = BigInt(`0x${frame.instruction.replace(/^0x/i, '')}`);
          const offsetValue = BigInt(`0x${frame.module_offset.replace(/^0x/i, '')}`);
          baseAddress = `0x${(instructionAddr - offsetValue).toString(16)}`;
        } catch {
          // If calculation fails, baseAddress remains undefined
        }
      }

      const address = formatAddress64(baseAddress);
      const offset = parseInt(frame.module_offset, 16);
      const instruction = formatAddress64(frame.instruction);

      return `${threadId}  ${moduleName} ${instruction} ${address} + ${offset}`;
    })
    .join('\n');
}

function formatThreads(crashReport: CrashReport): NonNullable<RawRumError['error']['threads']> {
  return crashReport.threads.map((thread, threadId) => ({
    name: `Thread ${thread.thread_index}`,
    crashed: thread.thread_index === crashReport.crash_info.crashing_thread,
    stack: formatFrameStack(thread.frames, threadId, crashReport.modules),
  }));
}

function formatBinaryImages(crashReport: CrashReport): RawRumError['error']['binary_images'] {
  return crashReport.modules.map((module) => ({
    uuid: module.debug_identifier ?? '',
    name: path.basename(module.code_file),
    is_system: isSystemModule(module.code_file),
    load_address: formatAddress64(module.base_address),
    max_address: calculateMaxAddress(module.base_address, module.size),
    arch: crashReport.system_info.cpu,
  }));
}

function isSystemModule(codeFile: string): boolean {
  return (
    // macOS
    codeFile.includes('/System/Library/') ||
    codeFile.includes('/usr/lib/') ||
    // Windows
    codeFile.includes('\\Windows\\') ||
    codeFile.includes('\\System32\\') ||
    // Linux
    codeFile.startsWith('/lib/') ||
    codeFile.startsWith('/usr/lib/')
  );
}

async function getFilesRecursive(dir: string, ext: string): Promise<string[]> {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  let results: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results = results.concat(await getFilesRecursive(fullPath, ext));
    } else if (entry.isFile() && entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }

  return results;
}
