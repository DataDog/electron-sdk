const SITE_TO_HOST: Record<string, string> = {
  'datad0g.com': 'dd.datad0g.com',
  'datadoghq.com': 'app.datadoghq.com',
  'datadoghq.eu': 'app.datadoghq.eu',
};

export function buildRumExplorerUrl(
  config: { site: string; applicationId: string; clientToken: string },
  sessionId: string
) {
  const host = SITE_TO_HOST[config.site] ?? config.site;
  const now = Date.now();
  const query = `@type:session @application.id:${config.applicationId} @session.id:${sessionId}`;
  const params = new URLSearchParams({
    query,
    from_ts: String(now - 60 * 60 * 1000), // 1h
    to_ts: String(now),
    live: 'true',
  });

  return `https://${host}/rum/sessions?${params.toString()}`;
}
