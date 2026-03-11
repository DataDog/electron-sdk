export function computeIntakeUrlForTrack(site: string, trackType: string, proxy?: string): string {
  if (proxy) {
    return proxy;
  }
  // For sites with subdomains (e.g., us3.datadoghq.com), replace the first dot with a dash
  const parts = site.split('.');
  let intakeSite: string;

  if (parts.length > 2) {
    // Has subdomain (e.g., us3.datadoghq.com -> us3-datadoghq.com)
    const subdomain = parts[0];
    const rest = parts.slice(1).join('.');
    intakeSite = `${subdomain}-${rest}`;
  } else {
    // No subdomain (e.g., datadoghq.com, ddog-gov.com)
    intakeSite = site;
  }

  return `https://browser-intake-${intakeSite}/api/v2/${trackType}`;
}
