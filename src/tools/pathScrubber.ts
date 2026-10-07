import * as fs from 'node:fs/promises';
import { app } from 'electron';
import { addError } from '../domain/telemetry';
import { display } from './display';

// Regex sources below match the *serialized* (JSON) payload: one backslash of the original string is two backslashes
// in JSON, so `\\\\` matches one original backslash. A scrubbed path is replaced wherever it appears, even inside a
// longer path; the only left-side requirement is structural: an even number of backslashes before it, and no unfinished
// `\uXXXX` escape (the `f` of `file:` is a hex digit), so a match never starts inside a JSON escape.
const NOT_INSIDE_JSON_ESCAPE = String.raw`(?<=(?:^|[^\\])(?:\\\\)*)(?<!(?:^|[^\\])(?:\\\\)*\\u[0-9A-Fa-f]{0,3})`;
// Without a separator, a scrubbed path must not be glued to a longer file or folder name (`MyApp2`, `app-update.yml`,
// `MyApp.backup`); a sentence-ending dot is fine.
const NOT_FOLLOWED_BY_NAME = String.raw`(?![\w-]|\.[\w-])`;
// First character of a POSIX path in a payload: `/` for a raw path, `f` for a file:// URL.
const POSIX_START = '[/f]';
const URL_SAFE_CHARACTER = /[A-Za-z0-9\-._~/]/;

/**
 * Replaces the app path with `/` in serialized payloads. Its main purpose is consistent paths for source maps, whatever
 * the installation folder; masking user paths is best effort.
 *
 * Strategy: it works on the serialized JSON, right before payloads are written, so every field of every payload type
 * is covered. Each scrubbed path (the app path, its unpacked folder and their realpaths) compiles one regex matching
 * all its notations (raw path and file:// URL with or without percent-encoding), never glued to a longer file or
 * folder name, but replaced even inside a longer path.
 *
 * Known limits:
 * - Data folders (`userData`, `crashDumps`) are not masked.
 * - URLs percent-encoding unreserved characters (`%61`) are not matched.
 * - A non-ASCII character ends a path (`MyAppé` becomes `/é`).
 */
export class PathScrubber {
  private failureReported = false;

  private constructor(private readonly patterns: RegExp[]) {}

  static async init(
    appPath: () => string = () => app.getAppPath(),
    realpath: (path: string) => Promise<string> = fs.realpath
  ): Promise<PathScrubber> {
    const path = readAppPath(appPath);
    // Unpacked files keep their relative layout next to the archive and Electron redirects reads to them: same logical
    // location as packed files.
    const scrubbedPaths = path === undefined ? [] : await withRealpaths([path, `${path}.unpacked`], realpath);
    // Longest path first: a scrubbed path can appear inside another one (`/var/x` inside its macOS realpath
    // `/private/var/x`), and replacing the shorter one first would leave the rest of the longer one in place.
    scrubbedPaths.sort((a, b) => b.length - a.length);
    return new PathScrubber(scrubbedPaths.map(compilePattern));
  }

  /** Valid JSON in, valid JSON out, identical outside the matched paths. Never throws. */
  scrub(serialized: string): string {
    try {
      return this.patterns.reduce((text, pattern) => text.replace(pattern, '/'), serialized);
    } catch {
      // An unscrubbed payload is better than a lost one: send it as is and report once.
      if (!this.failureReported) {
        this.failureReported = true;
        addError(new Error('Path scrubbing failed'));
      }
      return serialized;
    }
  }
}

// A skipped app path is only displayed locally: telemetry can't be delivered yet, and the path itself must never be
// shown.
function readAppPath(appPath: () => string): string | undefined {
  let path: string;
  try {
    path = withoutTrailingSeparators(appPath());
  } catch {
    display.error('Path scrubbing skipped appPath: unreadable path');
    return undefined;
  }
  if (isDegenerate(path)) {
    display.error('Path scrubbing skipped appPath: degenerate path');
    return undefined;
  }
  return path;
}

function withoutTrailingSeparators(path: string): string {
  return path.replace(/[\\/]+$/, '');
}

// Empty, root or single-segment paths would rewrite almost every absolute path.
function isDegenerate(path: string): boolean {
  return path.split(/[\\/]/).filter(Boolean).length < 2;
}

// Node reports realpath'd filenames in stacks while Electron paths are not resolved (macOS `/var` vs `/private/var`).
async function withRealpaths(paths: string[], realpath: (path: string) => Promise<string>): Promise<string[]> {
  const resolvedPaths = await Promise.all(
    paths.map(async (path) => {
      try {
        return withoutTrailingSeparators(await realpath(path));
      } catch {
        // For example the unpacked folder, which only exists when the app unpacks files.
        return undefined;
      }
    })
  );
  const result = [...paths];
  paths.forEach((path, index) => {
    const resolved = resolvedPaths[index];
    if (resolved !== undefined && resolved !== path && !isDegenerate(resolved)) {
      result.push(resolved);
    }
  });
  return result;
}

// A path appears raw (Node stacks, error messages) or as a file URL (renderer URLs, replay, profiles).
function compilePattern(path: string): RegExp {
  return pathPattern(POSIX_START, regexEscape(jsonText(path)), '/', `file://${urlPath(path)}`);
}

// Without a separator, a right boundary is required. The cheap lookahead on the possible first characters runs before
// the variable-length lookbehinds, which would otherwise scan back over a whole backslash run at each of its positions
// (quadratic time).
function pathPattern(start: string, raw: string, rawSeparator: string, url: string): RegExp {
  return new RegExp(
    `(?=${start})${NOT_INSIDE_JSON_ESCAPE}(?:${raw}(?:${rawSeparator}|${NOT_FOLLOWED_BY_NAME})|${url}(?:/|${NOT_FOLLOWED_BY_NAME}))`,
    'g'
  );
}

// URL encoding varies by producer (Chromium for renderer URLs, Node's pathToFileURL elsewhere): any character outside
// the unreserved set may appear as itself or percent-encoded.
function urlPath(path: string): string {
  return Array.from(path)
    .map((character) =>
      URL_SAFE_CHARACTER.test(character)
        ? regexEscape(character)
        : `(?:${regexEscape(jsonText(character))}|${percentEncoded(character)})`
    )
    .join('');
}

function percentEncoded(character: string): string {
  return Array.from(Buffer.from(character, 'utf8'))
    .map((byte) => `%${caseInsensitiveHex(byte.toString(16).toUpperCase().padStart(2, '0'))}`)
    .join('');
}

function caseInsensitiveHex(hex: string): string {
  return Array.from(hex)
    .map((digit) => (/[A-F]/.test(digit) ? `[${digit}${digit.toLowerCase()}]` : digit))
    .join('');
}

function jsonText(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

function regexEscape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}
