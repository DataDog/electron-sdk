import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addError } from '../domain/telemetry';
import { display } from './display';
import { PathScrubber } from './pathScrubber';

const APP = '/Users/alice/My App.app/Contents/Resources/app.asar';

const ELECTRON_APP = '/opt/Electron Default/app.asar';

vi.mock('electron', () => ({ app: { getAppPath: () => ELECTRON_APP } }));
vi.mock('../domain/telemetry', () => ({ addError: vi.fn() }));
vi.mock('./display', () => ({ display: { error: vi.fn() } }));

function createScrubber(
  appPath: string | (() => string) = APP,
  realpath: (path: string) => Promise<string> = (path) => Promise.resolve(path)
) {
  return PathScrubber.init(typeof appPath === 'function' ? appPath : () => appPath, realpath);
}

// Scrubs a string the way payloads are scrubbed: serialized, then parsed back to compare readable values.
function scrubString(scrubber: PathScrubber, value: string): string {
  return JSON.parse(scrubber.scrub(JSON.stringify(value))) as string;
}

describe('PathScrubber', () => {
  beforeEach(() => {
    vi.mocked(addError).mockClear();
    vi.mocked(display.error).mockClear();
  });

  describe('POSIX paths', () => {
    it.each([
      ['raw path in a stack frame', `at f (${APP}/dist/main.js:10:5)`, 'at f (/dist/main.js:10:5)'],
      [
        'encoded file URL',
        'file:///Users/alice/My%20App.app/Contents/Resources/app.asar/dist/renderer.js',
        '/dist/renderer.js',
      ],
      ['unencoded file URL', `file://${APP}/dist/renderer.js`, '/dist/renderer.js'],
      ['unpacked folder', `${APP}.unpacked/node_modules/foo/x.js`, '/node_modules/foo/x.js'],
      ['bare app path', APP, '/'],
      ['path in an error message', `ENOENT: open '${APP}/package.json'`, "ENOENT: open '/package.json'"],
      [
        'sibling folder',
        '/Users/alice/My App.app/Contents/Resources/other/x.js',
        '/Users/alice/My App.app/Contents/Resources/other/x.js',
      ],
      ['folder name followed by a space', `${APP} Helper/x`, '/ Helper/x'],
      ['inside a longer path', `/mnt/backup${APP}/x`, '/mnt/backup/x'],
      ['inside backticks', 'cannot read `' + APP + '/x`', 'cannot read `/x`'],
      ['inside brackets', `[${APP}]`, '[/]'],
      ['inside an HTML tag', `<p>${APP}</p>`, '<p>/</p>'],
      ['at the end of a sentence', `Failed to open ${APP}.`, 'Failed to open /.'],
      ['followed by a word', `${APP} is not writable`, '/ is not writable'],
      ['longer folder name', `${APP}2/x`, `${APP}2/x`],
      ['folder with an extension', `${APP}.backup/x`, `${APP}.backup/x`],
      ['closing curly quote', `open “${APP}”`, 'open “/”'],
      ['closing CJK bracket', `「${APP}」`, '「/」'],
      [
        'different case',
        '/Users/Alice/My App.app/Contents/Resources/app.asar/x',
        '/Users/Alice/My App.app/Contents/Resources/app.asar/x',
      ],
      [
        'multiple occurrences and escaped newlines',
        `Error: boom\n    at f (${APP}/dist/a.js:1:1)\n    at g (${APP}/dist/b.js:2:2)`,
        'Error: boom\n    at f (/dist/a.js:1:1)\n    at g (/dist/b.js:2:2)',
      ],
      ['right after an escaped newline', `boom\n${APP}/x`, 'boom\n/x'],
      ['CSS url inside a quoted attribute', `url("file://${APP}/assets/bg.png")`, 'url("/assets/bg.png")'],
      ['raw path after an escaped control character ending in f', `\x1file://${APP}/x`, '\x1file:///x'],
    ])('scrubs %s', async (_, input, expected) => {
      expect(scrubString(await createScrubber(), input)).toBe(expected);
    });

    it('keeps files next to an asar-less app folder', async () => {
      const appPath = '/Applications/MyApp.app/Contents/Resources/app';
      expect(scrubString(await createScrubber(appPath), `${appPath}-update.yml`)).toBe(`${appPath}-update.yml`);
    });

    it.each([
      ['regex special characters', '/Users/al(i)ce+$[x]/app.asar', '/Users/al(i)ce+$[x]/app.asar/x.js'],
      ['JSON special characters', '/Users/a"b\\c/app.asar', '/Users/a"b\\c/app.asar/x.js'],
      ['URL special characters, raw', "/Users/a#b%c'd/app.asar", "/Users/a#b%c'd/app.asar/x.js"],
      ['URL special characters, encoded', "/Users/a#b%c'd/app.asar", 'file:///Users/a%23b%25c%27d/app.asar/x.js'],
      ['non-ASCII, encoded', '/Users/José/app.asar', 'file:///Users/Jos%C3%A9/app.asar/x.js'],
      ['non-ASCII, lowercase encoding', '/Users/José/app.asar', 'file:///Users/Jos%c3%a9/app.asar/x.js'],
      ['non-ASCII, unencoded', '/Users/José/app.asar', 'file:///Users/José/app.asar/x.js'],
    ])('matches paths with %s', async (_, appPath, input) => {
      expect(scrubString(await createScrubber(appPath), input)).toBe('/x.js');
    });
  });

  describe('app path', () => {
    it('reads the app path from Electron by default', async () => {
      const scrubber = await PathScrubber.init(undefined, (path) => Promise.resolve(path));
      expect(scrubString(scrubber, `${ELECTRON_APP}/x`)).toBe('/x');
    });

    it('also matches the realpath of the app path', async () => {
      const scrubber = await createScrubber('/var/folders/x/app.asar', (path) =>
        Promise.resolve(path.startsWith('/var/') ? `/private${path}` : path)
      );
      expect(scrubString(scrubber, '/private/var/folders/x/app.asar/dist/a.js')).toBe('/dist/a.js');
      expect(scrubString(scrubber, '/var/folders/x/app.asar/dist/a.js')).toBe('/dist/a.js');
    });

    it('matches the realpath resolved by default', async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'path-scrubber-'));
      try {
        const target = path.join(directory, 'target');
        const link = path.join(directory, 'link');
        await fs.mkdir(target);
        await fs.symlink(target, link);
        const scrubber = await PathScrubber.init(() => link);
        expect(scrubString(scrubber, `${await fs.realpath(target)}/dist/a.js`)).toBe('/dist/a.js');
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    it('ignores paths whose realpath cannot be resolved', async () => {
      const scrubber = await createScrubber(APP, () => Promise.reject(new Error('ENOENT')));
      expect(scrubString(scrubber, `${APP}/x`)).toBe('/x');
    });

    it('ignores a degenerate realpath', async () => {
      const scrubber = await createScrubber(APP, (path) => Promise.resolve(path === APP ? '/Users' : path));
      expect(scrubString(scrubber, '/Users/bob/x')).toBe('/Users/bob/x');
      expect(scrubString(scrubber, `${APP}/x`)).toBe('/x');
    });

    it('ignores trailing separators', async () => {
      expect(scrubString(await createScrubber(`${APP}/`), `${APP}/x`)).toBe('/x');
    });

    it.each([
      ['root', '/'],
      ['single segment', '/Users'],
      ['empty', ''],
    ])(
      'skips a degenerate app path (%s), displayed without the path itself, and sends no telemetry',
      async (_, appPath) => {
        const scrubber = await createScrubber(appPath);

        expect(scrubString(scrubber, '/etc/hosts')).toBe('/etc/hosts');
        expect(vi.mocked(display.error).mock.calls).toEqual([['Path scrubbing skipped appPath: degenerate path']]);
        expect(addError).not.toHaveBeenCalled();
      }
    );

    it('skips an unreadable app path, displayed without the path itself, and sends no telemetry', async () => {
      const scrubber = await createScrubber(() => {
        throw new Error('unavailable');
      });

      expect(scrubber.scrub(JSON.stringify(`${APP}/x`))).toBe(JSON.stringify(`${APP}/x`));
      expect(vi.mocked(display.error).mock.calls).toEqual([['Path scrubbing skipped appPath: unreadable path']]);
      expect(addError).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the input unchanged and reports once when scrubbing throws', async () => {
      const scrubber = await createScrubber();
      const serialized = JSON.stringify(`${APP}/x`);
      const replaceSpy = vi.spyOn(String.prototype, 'replace').mockImplementation(() => {
        throw new Error('broken');
      });
      const results = [scrubber.scrub(serialized), scrubber.scrub(serialized)];
      // Restored before asserting: expect itself relies on String.prototype.replace.
      replaceSpy.mockRestore();

      expect(results).toEqual([serialized, serialized]);
      expect(addError).toHaveBeenCalledTimes(1);
      expect((vi.mocked(addError).mock.calls[0][0] as Error).message).toBe('Path scrubbing failed');
    });
  });
});
