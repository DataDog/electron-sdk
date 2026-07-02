import { describe, it, expect, vi, beforeEach } from 'vitest';
import { instrumentElectron } from './instrumentElectron';
import { patchBrowserWindow } from './browserWindow';
import { patchIpcMain, patchWebContents } from './ipc';
import { patchNet } from './net';

vi.mock('./browserWindow', () => ({
  resolvePreloadPath: vi.fn(() => '/fake/preload.js'),
  patchBrowserWindow: vi.fn(),
}));
vi.mock('./ipc', () => ({
  patchIpcMain: vi.fn(),
  patchWebContents: vi.fn(),
}));
vi.mock('./net', () => ({
  patchNet: vi.fn(),
}));

function fakeElectron(): typeof import('electron') {
  return {
    ipcMain: {},
    BrowserWindow: class BrowserWindow {},
    net: {},
    session: { defaultSession: {} },
    app: { isReady: () => true, once: vi.fn() },
  } as unknown as typeof import('electron');
}

describe('instrumentElectron', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('patches each Electron API once for a fresh electron module', () => {
    instrumentElectron(fakeElectron());

    expect(patchBrowserWindow).toHaveBeenCalledTimes(1);
    expect(patchBrowserWindow).toHaveBeenCalledWith(expect.anything(), '/fake/preload.js');
    expect(patchIpcMain).toHaveBeenCalledTimes(1);
    expect(patchWebContents).toHaveBeenCalledTimes(1);
    expect(patchNet).toHaveBeenCalledTimes(1);
  });

  it('is idempotent: a second call on the same electron module does not re-patch', () => {
    const electron = fakeElectron();

    instrumentElectron(electron);
    instrumentElectron(electron);

    expect(patchBrowserWindow).toHaveBeenCalledTimes(1);
    expect(patchIpcMain).toHaveBeenCalledTimes(1);
    expect(patchWebContents).toHaveBeenCalledTimes(1);
    expect(patchNet).toHaveBeenCalledTimes(1);
  });

  it('patches a different electron module independently', () => {
    // Simulates the CJS and ESM copies sharing the same native electron singleton: the guard lives
    // on the module object, so a distinct object is instrumented on its own.
    instrumentElectron(fakeElectron());
    instrumentElectron(fakeElectron());

    expect(patchNet).toHaveBeenCalledTimes(2);
  });

  it('skips patching APIs that are absent', () => {
    instrumentElectron({ app: { isReady: () => true } } as unknown as typeof import('electron'));

    expect(patchIpcMain).not.toHaveBeenCalled();
    expect(patchWebContents).not.toHaveBeenCalled();
    expect(patchNet).not.toHaveBeenCalled();
  });

  it('does not skip other patches when BrowserWindow injection throws', () => {
    vi.mocked(patchBrowserWindow).mockImplementationOnce(() => {
      throw new Error('BrowserWindow not writable');
    });

    instrumentElectron(fakeElectron());

    expect(patchIpcMain).toHaveBeenCalledTimes(1);
    expect(patchNet).toHaveBeenCalledTimes(1);
  });
});
