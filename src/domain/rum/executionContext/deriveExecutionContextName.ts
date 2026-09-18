// URL.hostname keeps the brackets around an IPv6 literal (e.g. '[::1]'), unlike URL.host.
const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

// Bounds payload size and keeps a hostless content-bearing scheme (e.g. data:) from placing
// arbitrary page content into the name.
const MAX_NAME_LENGTH = 200;

/**
 * Derives a human-readable name for a renderer execution context from its webContents URL.
 * http(s) URLs are kept as-is, except on localhost/loopback where the domain and port are
 * dropped (dev servers are already identified by their path, and the port is noise there).
 * Any other scheme with a host — a custom app protocol (app://, devtools://,
 * chrome-extension://, ...) — gets the same treatment as localhost, since the host there is
 * just a fixed marker rather than a meaningful remote domain. file:// keeps only its filename.
 * A hostless scheme (about:blank) or an unparseable string falls back to its last path segment.
 * Returns undefined for an empty URL (webContents created but not yet navigated).
 */
export function deriveExecutionContextName(url: string): string | undefined {
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return truncate(url.split('/').pop() || url);
  }

  if (parsed.protocol === 'file:') {
    return truncate(url.split('/').pop() || url);
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (LOCALHOST_HOSTNAMES.has(parsed.hostname)) {
      return truncate(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
    return truncate(url);
  }

  if (parsed.host) {
    return truncate(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  }

  return truncate(url.split('/').pop() || url);
}

function truncate(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}
