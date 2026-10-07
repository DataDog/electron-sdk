import { realpathSync } from 'node:fs';

export interface PayloadText {
  /** Intake route the payload came from (e.g. `/api/v2/rum`), to name it in a failure. */
  source: string;
  text: string;
}

export class AppPathCheck {
  private appPaths = new Set<string>();

  register(appPath: string): void {
    this.appPaths.add(appPath);
    this.appPaths.add(realpathSync(appPath));
  }

  /**
   * Fails if a string value of a captured payload contains a registered app path, in any of these notations:
   * - as is: POSIX path, Windows path with backslashes (`\\?\` prefix included)
   * - with `/` separators: Windows path with forward slashes, `file:///C:/…` URL
   * - percent-decoded: encoded `file://` URLs
   * Case is ignored on Windows.
   */
  assert(payloadTexts: PayloadText[]): void {
    const forms = [...this.appPaths].flatMap((path) => [path, path.replace(/\\/g, '/')]).map(normalizeCase);
    const leaks: string[] = [];
    for (const { source, text } of payloadTexts) {
      for (const value of stringValues(text)) {
        const candidates = [value, safeDecodeURI(value)].map(normalizeCase);
        const leaked = forms.find((form) => candidates.some((candidate) => candidate.includes(form)));
        if (leaked) {
          leaks.push(`${source}: ${leaked} in ${JSON.stringify(value.slice(0, 200))}`);
        }
      }
    }
    if (leaks.length > 0) {
      throw new Error(`Payloads contain the absolute app path:\n${leaks.join('\n')}`);
    }
  }
}

// Windows paths are case-insensitive.
function normalizeCase(value: string): string {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

// Every string value of a JSON (or NDJSON) payload; a non-JSON payload is checked as a whole.
function stringValues(text: string): string[] {
  const values: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string') {
      values.push(value);
    } else if (value && typeof value === 'object') {
      Object.values(value).forEach(visit);
    }
  };
  for (const line of text.split('\n').filter(Boolean)) {
    try {
      visit(JSON.parse(line));
    } catch {
      values.push(line);
    }
  }
  return values;
}

function safeDecodeURI(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
