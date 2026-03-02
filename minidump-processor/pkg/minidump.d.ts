/* tslint:disable */
/* eslint-disable */

/**
 * Process a minidump with stack walking and optional symbol resolution.
 *
 * # Arguments
 * * `dump_bytes` - The minidump file as a byte array
 * * `symbol_urls` - Optional array of symbol server URLs (not supported in WASM)
 *
 * # Returns
 * A Promise resolving to a JSON string with complete crash analysis
 */
export function process_minidump(dump_bytes: Uint8Array, symbol_urls?: string[] | null): Promise<any>;
