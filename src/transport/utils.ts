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

export function computeIntakeUrlForTrack(site: string, trackType: string, proxy?: string): string {
  const path = `/api/v2/${trackType}?ddsource=electron`;

  if (proxy) {
    return `${proxy}?ddforward=${encodeURIComponent(path)}`;
  }

  return `https://browser-intake-${computeIntakeSite(site)}${path}`;
}
