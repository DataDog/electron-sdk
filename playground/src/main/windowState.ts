import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

const WINDOW_STATE_FILE = path.join(app.getPath('userData'), 'window-state.json');

export function loadWindowState(): WindowBounds | null {
  try {
    if (fs.existsSync(WINDOW_STATE_FILE)) {
      const data = fs.readFileSync(WINDOW_STATE_FILE, 'utf8');
      return JSON.parse(data) as WindowBounds;
    }
  } catch (err) {
    console.log('Failed to load window state:', err);
  }
  return null;
}

export function saveWindowState(window: BrowserWindow): void {
  try {
    const bounds = window.getBounds();
    fs.writeFileSync(WINDOW_STATE_FILE, JSON.stringify(bounds, null, 2));
  } catch (err) {
    console.log('Failed to save window state:', err);
  }
}
