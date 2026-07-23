// For sites with subdomains (e.g., us3.datadoghq.com), replace the first dot with a dash
function computeIntakeSite(site: string): string {
  const parts = site.split('.');

  if (parts.length > 2) {
    // Has subdomain (e.g., us3.datadoghq.com -> us3-datadoghq.com)
    return `${parts[0]}-${parts.slice(1).join('.')}`;
  }

  return site;
}

export function computeIntakeHostname(site: string, proxy?: string): string {
  if (proxy) {
    return new URL(proxy).hostname;
  }

  return `browser-intake-${computeIntakeSite(site)}`;
}

export function computeIntakeUrlForTrack(
  site: string,
  trackType: string,
  options?: { proxy?: string; subdomain?: string }
): string {
  const { proxy, subdomain } = options ?? {};
  // Use '&' separator if trackType already contains query params (e.g. profiling/quota?session_id=...)
  const separator = trackType.includes('?') ? '&' : '?';
  const path = `/api/v2/${trackType}${separator}ddsource=electron`;

  if (proxy) {
    const ddforward = encodeURIComponent(path);
    const subdomainParam = subdomain ? `&ddforwardSubdomain=${subdomain}` : '';
    return `${proxy}?ddforward=${ddforward}${subdomainParam}`;
  }
  const subdomainPrefix = subdomain ? `${subdomain}.` : '';
  return `https://${subdomainPrefix}browser-intake-${computeIntakeSite(site)}${path}`;
}

/**
 * Merges query parameters into an intake URL produced by {@link computeIntakeUrlForTrack},
 * overwriting any parameter of the same name (e.g. replacing the default `ddsource=electron`).
 *
 * Handles both URL shapes:
 *  - direct: params are set on the intake URL's own query string
 *  - proxy (`<proxy>?ddforward=<encoded path>`): params belong on the *forwarded* intake path,
 *    not the proxy URL, so they are merged inside `ddforward` and re-encoded.
 *
 * Needed because the replay intake follows Browser SDK conventions (`ddsource=browser`, auth and
 * metadata as query params). Naively appending `?${params}` would yield a second `?`, corrupting
 * both the direct URL and the proxy forwarding.
 */
export function appendIntakeParams(intakeUrl: string, params: Record<string, string>): string {
  const url = new URL(intakeUrl);
  const ddforward = url.searchParams.get('ddforward');

  if (ddforward !== null) {
    // Proxy form: fold the params into the forwarded intake path.
    const forwarded = new URL(ddforward, 'https://placeholder.invalid');
    for (const [key, value] of Object.entries(params)) {
      forwarded.searchParams.set(key, value);
    }
    url.searchParams.set('ddforward', `${forwarded.pathname}${forwarded.search}`);
    return url.toString();
  }

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}
