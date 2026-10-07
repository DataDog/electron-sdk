import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cleanBuildOutput, rendererBuildArgs, writeVersionFile } from './build.ts';

describe('cleanBuildOutput', () => {
  it('removes dist/ and the tsc build info, leaving sources untouched', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-build-'));
    try {
      fs.mkdirSync(path.join(dir, 'dist', 'main'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'dist', 'main', 'stale.js.map'), '{}');
      fs.writeFileSync(path.join(dir, 'tsconfig.tsbuildinfo'), '{}');
      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(path.join(dir, 'src', 'main.ts'), '');

      cleanBuildOutput(dir);

      expect(fs.existsSync(path.join(dir, 'dist'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'tsconfig.tsbuildinfo'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'src', 'main.ts'))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when there is no previous build', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-build-'));
    try {
      expect(() => cleanBuildOutput(dir)).not.toThrow();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeVersionFile', () => {
  it('writes the version to version.json, creating the directory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'playground-build-'));
    try {
      writeVersionFile('0.1.2', path.join(dir, 'dist'));
      expect(JSON.parse(fs.readFileSync(path.join(dir, 'dist', 'version.json'), 'utf8'))).toEqual({ version: '0.1.2' });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('rendererBuildArgs', () => {
  it('bundles the renderer with the version injected as a string literal', () => {
    expect(rendererBuildArgs('renderer', '0.1.2', false)).toEqual([
      'src/renderer.ts',
      '--bundle',
      '--format=esm',
      '--outfile=dist/renderer.js',
      '--sourcemap',
      '--define:__PLAYGROUND_VERSION__="0.1.2"',
    ]);
  });

  it('adds --watch in watch mode', () => {
    expect(rendererBuildArgs('secondary-renderer', 'abc123', true)).toEqual([
      'src/secondary-renderer.ts',
      '--bundle',
      '--format=esm',
      '--outfile=dist/secondary-renderer.js',
      '--sourcemap',
      '--define:__PLAYGROUND_VERSION__="abc123"',
      '--watch',
    ]);
  });

  it('escapes the version so it stays a valid JS string', () => {
    expect(rendererBuildArgs('renderer', 'a"b', false)).toContain('--define:__PLAYGROUND_VERSION__="a\\"b"');
  });
});
