// Run with `yarn vitest bench --run src/tools/pathScrubber.bench.ts` (through `yarn`, so the pinned Node is used).
import { bench, describe } from 'vitest';
import { PathScrubber } from './pathScrubber';

const APP = '/Users/alice/My App.app/Contents/Resources/app.asar';
const scrubber = await PathScrubber.init(
  () => APP,
  (path) => Promise.resolve(path)
);

const WINDOWS_APP = 'C:\\Users\\alice\\AppData\\Local\\Programs\\My App\\resources\\app.asar';
const windowsScrubber = await PathScrubber.init(
  () => WINDOWS_APP,
  (path) => Promise.resolve(path)
);

// Replay-like segment of about 10 MB (the segment cap): DOM records with text, attributes and stylesheets, a few of
// them carrying file URLs under the app path.
const records = Array.from({ length: 20000 }, (_, index) => ({
  type: 2,
  timestamp: 1700000000000 + index,
  data: {
    node: { tagName: 'div', attributes: { class: `item item-${index}`, style: 'color: red; margin: 0 auto;' } },
    text: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt '.repeat(4),
    cssText:
      index % 100 === 0 ? `.bg { background: url("file://${APP}/assets/bg-${index}.png") }` : '.x { color: blue }',
  },
}));
const segment = JSON.stringify({ records });

// Same segment, with about 1000 records carrying raw Windows paths (error stacks) under the app path.
const windowsSegment = JSON.stringify({
  records: records.map((record, index) =>
    index % 20 === 0 ? { ...record, error: `at f (${WINDOWS_APP}\\dist\\main.js:1:1)` } : record
  ),
});

// Pathological input for the lookbehinds: a backslash run of about 1 MB, where a Windows path could start at any
// position.
const backslashes = JSON.stringify('\\'.repeat(512 * 1024));

// Results depend heavily on the V8 version (about 30x slower on V8 12 / Node 22 than on V8 14 / Node 25 and Electron
// 39+), the variable-length lookbehind being the likely cause.
describe('PathScrubber.scrub', () => {
  bench(`${(segment.length / 1024 / 1024).toFixed(1)} MB replay segment`, () => {
    scrubber.scrub(segment);
  });

  bench(`${(windowsSegment.length / 1024 / 1024).toFixed(1)} MB with raw Windows paths`, () => {
    windowsScrubber.scrub(windowsSegment);
  });

  bench('1 MB of backslashes, Windows', () => {
    windowsScrubber.scrub(backslashes);
  });
});
