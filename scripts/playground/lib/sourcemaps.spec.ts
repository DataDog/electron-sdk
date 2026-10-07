import { describe, it, expect } from 'vitest';
import { UPLOAD_TARGETS, buildUploadArgs, parseUploadOptions } from './sourcemaps.ts';

describe('UPLOAD_TARGETS', () => {
  it('uploads renderer maps for each protocol and main maps for the rewritten app path', () => {
    expect(UPLOAD_TARGETS).toEqual([
      { service: 'playground-renderer', minifiedPathPrefix: 'app://app/' },
      { service: 'playground-renderer', minifiedPathPrefix: '/' },
      { service: 'playground-renderer', minifiedPathPrefix: '/dist/' },
      { service: 'playground-main', minifiedPathPrefix: '/dist/' },
    ]);
  });
});

describe('buildUploadArgs', () => {
  it('builds a datadog-ci upload of dist/ with git metadata', () => {
    expect(buildUploadArgs({ service: 'playground-main', minifiedPathPrefix: '/dist/' }, 'abc123', false)).toEqual([
      'sourcemaps',
      'upload',
      './dist',
      '--service',
      'playground-main',
      '--release-version',
      'abc123',
      '--minified-path-prefix',
      '/dist/',
      '--repository-url',
      'https://github.com/DataDog/electron-sdk',
    ]);
  });

  it('adds --dry-run when requested', () => {
    expect(buildUploadArgs(UPLOAD_TARGETS[0], 'abc123', true)).toContain('--dry-run');
  });

  it('never disables git metadata', () => {
    expect(buildUploadArgs(UPLOAD_TARGETS[0], 'abc123', true)).not.toContain('--disable-git');
  });
});

describe('parseUploadOptions', () => {
  it('defaults to the staging site', () => {
    expect(parseUploadOptions([], { DATADOG_API_KEY: 'key' })).toEqual({
      site: 'datad0g.com',
      dryRun: false,
      apiKey: 'key',
    });
  });

  it('selects the prod site with PLAYGROUND_ENV=prod', () => {
    expect(parseUploadOptions([], { PLAYGROUND_ENV: 'prod', DATADOG_API_KEY: 'key' }).site).toBe('datadoghq.com');
  });

  it('rejects an unknown PLAYGROUND_ENV', () => {
    expect(() => parseUploadOptions([], { PLAYGROUND_ENV: 'nope', DATADOG_API_KEY: 'key' })).toThrow(/PLAYGROUND_ENV/);
  });

  it('requires DATADOG_API_KEY outside dry-run', () => {
    expect(() => parseUploadOptions([], {})).toThrow(/DATADOG_API_KEY/);
  });

  it('allows dry-run without an api key', () => {
    expect(parseUploadOptions(['--dry-run'], {})).toEqual({
      site: 'datad0g.com',
      dryRun: true,
      apiKey: 'dry-run',
    });
  });
});
