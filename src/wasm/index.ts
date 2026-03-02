import { process_minidump } from '../../minidump-processor/pkg/minidump';
import type { CrashReport } from './types';

/**
 * Process a minidump file and return structured crash information.
 *
 * Runs the minidump through the WASM-compiled minidump-processor (stack walking,
 * module resolution) and returns a typed result. Symbol resolution via HTTP is
 * not supported in WASM builds — stack frames will contain addresses but not
 * function names.
 *
 * @param bytes - Raw minidump file content
 * @returns Structured crash report including crash info, threads, and loaded modules
 */
export async function processMinidump(bytes: Uint8Array): Promise<CrashReport> {
  const json = (await process_minidump(bytes, null)) as string;
  return JSON.parse(json) as CrashReport;
}

export type { CrashReport };
