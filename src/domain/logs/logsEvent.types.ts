/**
 * A log event as the Browser Logs SDK assembles it, hand-written rather than generated.
 *
 * Unlike RUM and telemetry events, logs have no schema in `rum-events-format` — the Browser SDK
 * declares its own `LogsEvent` in `packages/browser-logs/src/logsEvent.types.ts`. Only the fields
 * the main process reads or replaces are named here; everything else the renderer sends is carried
 * through untouched, so a field browser-core adds does not need a change on this side.
 */
export interface LogsEvent {
  /** Start of the log in ms from epoch. Resolves the session the event is attributed to. */
  date: number;
  message: string;
  status: string;
  service?: string;
  /** Comma-separated `key:value` list built by the renderer from its own env/service/version. */
  ddtags?: string;
  /** RUM application the log belongs to. Replaced by the main process. */
  application_id?: string;
  /** Flat session id, alongside `session.id`. Both are replaced by the main process. */
  session_id?: string | null;
  session?: { id?: string | null; [key: string]: unknown };
  /** The renderer's own view. Kept: it is the view its RUM events carry. */
  view?: { id?: string; url?: string; referrer?: string; name?: string; [key: string]: unknown };
  /** The action the renderer's own SDK attributed the log to. Kept. */
  user_action?: { id?: string | string[]; [key: string]: unknown };
  usr?: Record<string, unknown> | null;
  account?: Record<string, unknown> | null;
  [key: string]: unknown;
}
