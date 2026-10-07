import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { addError } from '../domain/telemetry';
import { display } from './display';
import { PathScrubber } from './pathScrubber';

const POSIX_APP = '/Users/alice/My App.app/Contents/Resources/app.asar';

vi.mock('electron', () => ({ app: { getAppPath: () => POSIX_APP } }));
vi.mock('../domain/telemetry', () => ({ addError: vi.fn() }));
vi.mock('./display', () => ({ display: { error: vi.fn() } }));

function createScrubber(appPath: string = POSIX_APP, realpath: (path: string) => string = (path) => path) {
  return new PathScrubber(appPath, realpath);
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
      ['raw path in a stack frame', `at f (${POSIX_APP}/dist/main.js:10:5)`, 'at f (/dist/main.js:10:5)'],
      [
        'encoded file URL',
        'file:///Users/alice/My%20App.app/Contents/Resources/app.asar/dist/renderer.js',
        '/dist/renderer.js',
      ],
      ['unencoded file URL', `file://${POSIX_APP}/dist/renderer.js`, '/dist/renderer.js'],
      [
        'unpacked folder (not masked)',
        `${POSIX_APP}.unpacked/node_modules/foo/x.js`,
        `${POSIX_APP}.unpacked/node_modules/foo/x.js`,
      ],
      ['bare app path', POSIX_APP, '/'],
      ['path in an error message', `ENOENT: open '${POSIX_APP}/package.json'`, "ENOENT: open '/package.json'"],
      [
        'sibling folder',
        '/Users/alice/My App.app/Contents/Resources/other/x.js',
        '/Users/alice/My App.app/Contents/Resources/other/x.js',
      ],
      ['folder name followed by a space', `${POSIX_APP} Helper/x`, '/ Helper/x'],
      ['inside a longer path', `/mnt/backup${POSIX_APP}/x`, '/mnt/backup/x'],
      ['inside backticks', 'cannot read `' + POSIX_APP + '/x`', 'cannot read `/x`'],
      ['inside brackets', `[${POSIX_APP}]`, '[/]'],
      ['inside an HTML tag', `<p>${POSIX_APP}</p>`, '<p>/</p>'],
      ['at the end of a sentence', `Failed to open ${POSIX_APP}.`, 'Failed to open /.'],
      ['followed by a word', `${POSIX_APP} is not writable`, '/ is not writable'],
      ['longer folder name', `${POSIX_APP}2/x`, `${POSIX_APP}2/x`],
      ['folder with an extension', `${POSIX_APP}.backup/x`, `${POSIX_APP}.backup/x`],
      ['closing curly quote', `open “${POSIX_APP}”`, 'open “/”'],
      ['closing CJK bracket', `「${POSIX_APP}」`, '「/」'],
      [
        'different case',
        '/Users/Alice/My App.app/Contents/Resources/app.asar/x',
        '/Users/Alice/My App.app/Contents/Resources/app.asar/x',
      ],
      [
        'multiple occurrences and escaped newlines',
        `Error: boom\n    at f (${POSIX_APP}/dist/a.js:1:1)\n    at g (${POSIX_APP}/dist/b.js:2:2)`,
        'Error: boom\n    at f (/dist/a.js:1:1)\n    at g (/dist/b.js:2:2)',
      ],
      ['right after an escaped newline', `boom\n${POSIX_APP}/x`, 'boom\n/x'],
      ['CSS url inside a quoted attribute', `url("file://${POSIX_APP}/assets/bg.png")`, 'url("/assets/bg.png")'],
      ['raw path after an escaped control character ending in f', `\x1file://${POSIX_APP}/x`, '\x1file:///x'],
    ])('scrubs %s', (_, input, expected) => {
      expect(scrubString(createScrubber(), input)).toBe(expected);
    });

    it('keeps files next to an asar-less app folder', () => {
      const appPath = '/Applications/MyApp.app/Contents/Resources/app';
      expect(scrubString(createScrubber(appPath), `${appPath}-update.yml`)).toBe(`${appPath}-update.yml`);
    });

    it.each([
      ['regex special characters', '/Users/al(i)ce+$[x]/app.asar', '/Users/al(i)ce+$[x]/app.asar/x.js'],
      ['JSON special characters', '/Users/a"b\\c/app.asar', '/Users/a"b\\c/app.asar/x.js'],
      ['URL special characters, raw', "/Users/a#b%c'd/app.asar", "/Users/a#b%c'd/app.asar/x.js"],
      ['URL special characters, encoded', "/Users/a#b%c'd/app.asar", 'file:///Users/a%23b%25c%27d/app.asar/x.js'],
      ['non-ASCII, encoded', '/Users/José/app.asar', 'file:///Users/Jos%C3%A9/app.asar/x.js'],
      ['non-ASCII, lowercase encoding', '/Users/José/app.asar', 'file:///Users/Jos%c3%a9/app.asar/x.js'],
      ['non-ASCII, unencoded', '/Users/José/app.asar', 'file:///Users/José/app.asar/x.js'],
    ])('matches paths with %s', (_, appPath, input) => {
      expect(scrubString(createScrubber(appPath), input)).toBe('/x.js');
    });
  });

  describe('app path', () => {
    it('reads the app path from Electron by default', () => {
      const scrubber = new PathScrubber();
      expect(scrubString(scrubber, `${POSIX_APP}/x`)).toBe('/x');
    });

    it('also matches the realpath of the app path', () => {
      const scrubber = createScrubber('/var/folders/x/app.asar', (path) =>
        path.startsWith('/var/') ? `/private${path}` : path
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
        const scrubber = new PathScrubber(link);
        expect(scrubString(scrubber, `${await fs.realpath(target)}/dist/a.js`)).toBe('/dist/a.js');
      } finally {
        await fs.rm(directory, { recursive: true, force: true });
      }
    });

    it.runIf(process.platform === 'darwin')(
      'matches the realpath spelled like Node module filenames, not the one stored on disk',
      async () => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'path-scrubber-'));
        try {
          await fs.mkdir(path.join(directory, 'Cafe\u0301'));
          const appPath = path.join(directory, 'Caf\u00e9');
          await fs.writeFile(path.join(appPath, 'x.js'), '');
          const frame = realpathSync(path.join(appPath, 'x.js'));
          const scrubber = new PathScrubber(appPath);
          expect(scrubString(scrubber, frame)).toBe('/x.js');
        } finally {
          await fs.rm(directory, { recursive: true, force: true });
        }
      }
    );

    it('ignores paths whose realpath cannot be resolved', () => {
      const scrubber = createScrubber(POSIX_APP, () => {
        throw new Error('ENOENT');
      });
      expect(scrubString(scrubber, `${POSIX_APP}/x`)).toBe('/x');
    });

    it('ignores a degenerate realpath', () => {
      const scrubber = createScrubber(POSIX_APP, (path) => (path === POSIX_APP ? '/Users' : path));
      expect(scrubString(scrubber, '/Users/bob/x')).toBe('/Users/bob/x');
      expect(scrubString(scrubber, `${POSIX_APP}/x`)).toBe('/x');
    });

    it('ignores trailing separators', () => {
      expect(scrubString(createScrubber(`${POSIX_APP}/`), `${POSIX_APP}/x`)).toBe('/x');
    });

    it.each([
      ['root', '/'],
      ['single segment', '/Users'],
      ['empty', ''],
    ])('skips a degenerate app path (%s), displayed without the path itself, and sends no telemetry', (_, appPath) => {
      const scrubber = createScrubber(appPath);

      expect(scrubString(scrubber, '/etc/hosts')).toBe('/etc/hosts');
      expect(vi.mocked(display.error).mock.calls).toEqual([['Path scrubbing skipped appPath: degenerate path']]);
      expect(addError).not.toHaveBeenCalled();
    });
  });

  describe('failures', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('returns the input unchanged and reports once when scrubbing throws', () => {
      const scrubber = createScrubber();
      const serialized = JSON.stringify(`${POSIX_APP}/x`);
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
