// Bounds payload size and caps how much of a content-bearing scheme (e.g. data:) can leak.
const MAX_NAME_LENGTH = 200;

/**
 * Derives a human-readable name for a renderer execution context from its webContents URL.
 * - http(s): origin + path only — query, fragment, and credentials are dropped (e.g. an
 *   OAuth/SSO redirect's `?code=...`/`#access_token=...` shouldn't end up in the name).
 * - localhost/loopback and custom protocols with a host (app://, devtools://, ...): only
 *   path+query+hash survive (host/port are noise there, not identifying information).
 * - file://: filename only. Hostless/unparseable: last path segment.
 * - Empty URL: undefined (not yet navigated).
 */
export function deriveExecutionContextName(url: string): string | undefined {
  if (!url) {
    return undefined;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return truncate(lastPathSegment(url));
  }

  if (parsed.protocol === 'file:') {
    return truncate(lastPathSegment(parsed.href));
  }

  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
    if (isLocalhost(parsed.hostname)) {
      // WHATWG guarantees pathname is at least '/' for a special scheme like http(s).
      return truncate(`${parsed.pathname}${parsed.search}${parsed.hash}`);
    }
    return truncate(`${parsed.origin}${parsed.pathname}`);
  }

  if (parsed.host) {
    // Unlike http(s), a non-special scheme (e.g. app://app, no trailing slash) can parse to an
    // empty pathname; '' would freeze permanently, so fall back to '/'.
    return truncate(`${parsed.pathname || '/'}${parsed.search}${parsed.hash}`);
  }

  // Chromium commits an initial about:blank document for a window.open()-created renderer
  // before its real navigation; naming off that would freeze a meaningless permanent name.
  if (parsed.protocol === 'about:') {
    return undefined;
  }

  return truncate(lastPathSegment(parsed.href));
}

// Last non-empty '/'-separated segment (e.g. the filename for file://); a trailing slash would
// otherwise leak the full url. Falls back to the scheme itself if there's no segment at all.
function lastPathSegment(url: string): string {
  return url.split('/').filter(Boolean).pop() || url;
}

function truncate(name: string): string {
  return name.length > MAX_NAME_LENGTH ? name.slice(0, MAX_NAME_LENGTH) : name;
}

// URL.hostname keeps the brackets around an IPv6 literal (e.g. '[::1]'), unlike URL.host.
function isLocalhost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)
  );
}
