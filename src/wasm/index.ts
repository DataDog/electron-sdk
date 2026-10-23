import init, { process_minidump } from '../../minidump-processor/pkg/minidump';
import { WASM_BASE64 } from '../../minidump-processor/pkg/minidump_bg.wasm.base64';
import type { CrashReport } from './types';

let initPromise: Promise<void> | undefined;

function ensureInitialized(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      const buffer = Buffer.from(WASM_BASE64, 'base64');
      await init(buffer);
    })();
  }
  return initPromise;
}

/**
 * Process a minidump file and return structured crash information.
 *
 * Runs the minidump through the WASM-compiled minidump-processor (stack walking,
 * module resolution) and returns a typed result. Symbol resolution via HTTP is
 * not supported in WASM builds — stack frames will contain addresses but not
 * function names.
 *
 * WASM initialization is deferred to the first call.
 *
 * @param bytes - Raw minidump file content
 * @returns Structured crash report including crash info, threads, and loaded modules
 */
export async function processMinidump(bytes: Uint8Array): Promise<CrashReport> {
  await ensureInitialized();
  const json = (await process_minidump(bytes, null)) as string;
  return JSON.parse(json) as CrashReport;
}

export type { CrashReport };
