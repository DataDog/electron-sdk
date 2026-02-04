import { app } from 'electron';
import * as fs from 'fs/promises';
import * as path from 'path';
import { deepClone, generateUUID, Observable, ONE_HOUR, ONE_MINUTE, type Subscription } from '@datadog/browser-core';

export const SESSION_TIME_OUT_DELAY = 4 * ONE_HOUR;
export const SESSION_EXPIRATION_DELAY = 15 * ONE_MINUTE;
export const SESSION_FILE_NAME = '_dd_s';

export interface SessionManager {
  getSession(): Session;
  stop(): void;
}

export interface Session {
  id: string;
  status: SessionStatus;
}

export type SessionStatus = 'active' | 'expired';

/**
 * Session state stored on disk
 */
interface SessionState {
  id: string;
  created: number;
  lastActivity: number;
}

/**
 * Track session lifecycle
 * - store the Session on SESSION_FILE_NAME
 * - on start, if no Session is already active, create a new Session
 * - after SESSION_EXPIRATION_DELAY without activity, expire the Session
 * - after SESSION_TIME_OUT_DELAY if the Session is still active, expire the Session
 * - on activity, if the Session is expired, create a new Session
 *
 * @param activityObservable emits on end user activity
 */
export async function startSessionManager(activityObservable: Observable<void>): Promise<SessionManager> {
  let currentSession: Session;
  let inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  let activitySubscription: Subscription | undefined;

  async function initializeSession(): Promise<void> {
    const now = Date.now();
    const existingState = await loadSessionState();

    if (existingState && isSessionValid(existingState, now)) {
      currentSession = { id: existingState.id, status: 'active' };
      existingState.lastActivity = now;
      await saveSessionState(existingState);
      scheduleInactivityTimeout();
      scheduleSessionTimeout(existingState.created);
    } else {
      await createNewSession();
    }

    activitySubscription = activityObservable.subscribe(() => {
      // TODO monitor instead of catch
      updateActivity().catch(() => {});
    });
  }

  async function createNewSession(): Promise<void> {
    const now = Date.now();
    const state: SessionState = {
      id: generateUUID(),
      created: now,
      lastActivity: now,
    };

    currentSession = { id: state.id, status: 'active' };
    await saveSessionState(state);

    scheduleInactivityTimeout();
    scheduleSessionTimeout(state.created);
  }

  function expireSession(): void {
    clearTimers();
    currentSession.status = 'expired';
    // TODO monitor instead of catch
    deleteSessionFile().catch(() => {});
  }

  async function updateActivity(): Promise<void> {
    if (currentSession.status === 'expired') {
      await createNewSession();
      return;
    }

    const state = await loadSessionState();
    if (!state || state.id !== currentSession.id) {
      // TODO monitor error
      return;
    }

    state.lastActivity = Date.now();
    await saveSessionState(state);

    scheduleInactivityTimeout();
  }

  function scheduleInactivityTimeout(): void {
    if (inactivityTimeoutId !== undefined) {
      clearTimeout(inactivityTimeoutId);
    }
    inactivityTimeoutId = setTimeout(expireSession, SESSION_EXPIRATION_DELAY);
  }

  function scheduleSessionTimeout(createdAt: number): void {
    const now = Date.now();
    const remainingTime = SESSION_TIME_OUT_DELAY - (now - createdAt);
    if (remainingTime > 0) {
      sessionTimeoutId = setTimeout(expireSession, remainingTime);
    } else {
      expireSession();
    }
  }

  function clearTimers(): void {
    if (inactivityTimeoutId !== undefined) {
      clearTimeout(inactivityTimeoutId);
      inactivityTimeoutId = undefined;
    }
    if (sessionTimeoutId !== undefined) {
      clearTimeout(sessionTimeoutId);
      sessionTimeoutId = undefined;
    }
  }

  await initializeSession();

  return {
    getSession(): Session {
      return deepClone(currentSession);
    },
    stop(): void {
      clearTimers();
      if (activitySubscription) {
        activitySubscription.unsubscribe();
        activitySubscription = undefined;
      }
    },
  };
}

function getSessionFilePath(): string {
  return path.join(app.getPath('userData'), SESSION_FILE_NAME);
}

function isSessionValid(state: SessionState, now: number): boolean {
  const isNotExpired = now - state.lastActivity < SESSION_EXPIRATION_DELAY;
  const isNotTimedOut = now - state.created < SESSION_TIME_OUT_DELAY;
  return isNotExpired && isNotTimedOut;
}

async function loadSessionState(): Promise<SessionState | undefined> {
  try {
    const filePath = getSessionFilePath();
    await fs.access(filePath);
    const content = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(content) as SessionState;
  } catch {
    return undefined;
  }
}

async function saveSessionState(state: SessionState): Promise<void> {
  try {
    const filePath = getSessionFilePath();
    await fs.writeFile(filePath, JSON.stringify(state), 'utf-8');
  } catch (error) {
    console.error('Failed to save session state:', error);
  }
}

async function deleteSessionFile(): Promise<void> {
  try {
    const filePath = getSessionFilePath();
    await fs.unlink(filePath);
  } catch {
    // File might not exist, ignore error
  }
}
