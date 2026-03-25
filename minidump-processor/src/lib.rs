//! WebAssembly bindings for minidump parsing and analysis
//!
//! Provides a Node.js-compatible WASM interface for processing minidump crash
//! reports into structured JSON, used by the Datadog Electron SDK crash reporter.

use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
use minidump::*;
use minidump_processor::ProcessState;
use breakpad_symbols::{Symbolizer, SimpleSymbolSupplier};

/// Process a minidump with stack walking and optional symbol resolution.
///
/// # Arguments
/// * `dump_bytes` - The minidump file as a byte array
/// * `symbol_urls` - Optional array of symbol server URLs (not supported in WASM)
///
/// # Returns
/// A Promise resolving to a JSON string with complete crash analysis
#[wasm_bindgen]
pub fn process_minidump(
    dump_bytes: &[u8],
    symbol_urls: Option<Vec<String>>,
) -> js_sys::Promise {
    let dump_bytes = dump_bytes.to_vec();

    future_to_promise(async move {
        process_minidump_internal(&dump_bytes, symbol_urls)
            .await
            .map(|s| JsValue::from_str(&s))
            .map_err(|e| JsValue::from_str(&e))
    })
}

async fn process_minidump_internal(
    dump_bytes: &[u8],
    symbol_urls: Option<Vec<String>>,
) -> Result<String, String> {
    console_error_panic_hook::set_once();
    if let Some(urls) = &symbol_urls {
        if !urls.is_empty() {
            web_sys::console::warn_1(&wasm_bindgen::JsValue::from_str(
                "Warning: Symbol URLs are not supported in WASM builds.",
            ));
        }
    }

    let dump = Minidump::read(dump_bytes)
        .map_err(|e| format!("Failed to read minidump: {}", e))?;

    let supplier = SimpleSymbolSupplier::new(vec![]);
    let symbol_provider = Symbolizer::new(supplier);
    let state = minidump_processor::process_minidump(&dump, &symbol_provider)
        .await
        .map_err(|e| format!("Failed to process minidump: {}", e))?;

    state_to_json(&state)
}

fn state_to_json(state: &ProcessState) -> Result<String, String> {
    let mut result = serde_json::json!({ "status": "OK" });

    result["system_info"] = serde_json::json!({
        "os": state.system_info.os.to_string(),
        "cpu": state.system_info.cpu.to_string(),
        "cpu_info": state.system_info.cpu_info.as_ref().unwrap_or(&String::new()),
    });

    if let Some(exception_info) = &state.exception_info {
        result["crash_info"] = serde_json::json!({
            "type": exception_info.reason.to_string(),
            "address": format!("{:#x}", exception_info.address.0),
            "crashing_thread": state.requesting_thread,
        });
    }

    let mut threads_json = Vec::new();
    for (thread_idx, thread) in state.threads.iter().enumerate() {
        let frames: Vec<_> = thread.frames.iter().map(|frame| {
            serde_json::json!({
                "module": frame.module.as_ref().map(|m| m.code_file()).unwrap_or_default(),
                "module_offset": frame.module.as_ref()
                    .map(|m| format!("{:#x}", frame.instruction.saturating_sub(m.base_address())))
                    .unwrap_or_else(|| format!("{:#x}", frame.instruction)),
                "instruction": format!("{:#x}", frame.instruction),
                "function": frame.function_name.as_ref().unwrap_or(&String::new()),
                "trust": format!("{:?}", frame.trust),
            })
        }).collect();

        let thread_json = serde_json::json!({
            "thread_index": thread_idx,
            "frame_count": frames.len(),
            "frames": frames,
        });

        if state.requesting_thread == Some(thread_idx) {
            result["crashing_thread"] = thread_json.clone();
        }

        threads_json.push(thread_json);
    }

    result["threads"] = serde_json::json!(threads_json);
    result["thread_count"] = serde_json::json!(threads_json.len());

    let modules_json: Vec<_> = state.modules.iter().map(|module| {
        serde_json::json!({
            "base_address": format!("{:#x}", module.base_address()),
            "size": module.size(),
            "code_file": module.code_file(),
            "code_identifier": module.code_identifier().map(|id| id.to_string()),
            "debug_file": module.debug_file().map(|f| f.to_string()),
            "debug_identifier": module.debug_identifier().map(|id| id.to_string()),
            "version": module.version().map(|v| v.to_string()),
        })
    }).collect();

    result["modules"] = serde_json::json!(modules_json);
    result["module_count"] = serde_json::json!(modules_json.len());

    serde_json::to_string_pretty(&result)
        .map_err(|e| format!("Failed to serialize JSON: {}", e))
}
