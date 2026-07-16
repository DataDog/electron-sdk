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
