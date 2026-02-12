import { app } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { deepClone, generateUUID, ONE_HOUR, ONE_MINUTE, type Subscription } from '@datadog/browser-core';
import { EventManager, EventKind, LifecycleKind, type EndUserActivityEvent } from '../event';
import type { FormatHooks } from './hooks';
import { addError, setTimeout } from './telemetry/telemetry';
import { displayError } from '../tools/display';

export const SESSION_TIME_OUT_DELAY = 4 * ONE_HOUR;
export const SESSION_EXPIRATION_DELAY = 15 * ONE_MINUTE;
export const SESSION_FILE_NAME = '_dd_s';

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
 */
export class SessionManager {
  private currentSession!: Session;
  private inactivityTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private sessionTimeoutId: ReturnType<typeof setTimeout> | undefined;
  private activitySubscription: Subscription | undefined;

  private constructor(
    private readonly eventManager: EventManager,
    private readonly hooks: FormatHooks
  ) {}

  static async start(eventManager: EventManager, hooks: FormatHooks): Promise<SessionManager> {
    const manager = new SessionManager(eventManager, hooks);
    await manager.initializeSession();
    return manager;
  }

  getSession(): Session {
    return deepClone(this.currentSession);
  }

  stop(): void {
    this.clearTimers();
    if (this.activitySubscription) {
      this.activitySubscription.unsubscribe();
      this.activitySubscription = undefined;
    }
  }

  private async initializeSession(): Promise<void> {
    const now = Date.now();
    const existingState = await loadSessionState();

    if (existingState && isSessionValid(existingState, now)) {
      this.currentSession = { id: existingState.id, status: 'active' };
      existingState.lastActivity = now;
      await saveSessionState(existingState);
      this.scheduleInactivityTimeout();
      this.scheduleSessionTimeout(existingState.created);
    } else {
      await this.createNewSession();
    }

    this.activitySubscription = this.eventManager.registerHandler<EndUserActivityEvent>({
      canHandle: (event): event is EndUserActivityEvent =>
        event.kind === EventKind.LIFECYCLE && event.lifecycle === LifecycleKind.END_USER_ACTIVITY,
      handle: () => {
        this.updateActivity().catch(addError);
      },
    });

    this.registerHooks();
  }

  private async createNewSession(): Promise<void> {
    const now = Date.now();
    const state: SessionState = {
      id: generateUUID(),
      created: now,
      lastActivity: now,
    };

    this.currentSession = { id: state.id, status: 'active' };
    await saveSessionState(state);

    this.scheduleInactivityTimeout();
    this.scheduleSessionTimeout(state.created);
  }

  private expireSession(): void {
    this.clearTimers();
    this.currentSession.status = 'expired';
    deleteSessionFile().catch(addError);
  }

  private async updateActivity(): Promise<void> {
    if (this.currentSession.status === 'expired') {
      await this.createNewSession();
      return;
    }

    const state = await loadSessionState();
    if (!state || state.id !== this.currentSession.id) {
      addError(new Error('SessionManager: Invalid session state'));
      return;
    }

    state.lastActivity = Date.now();
    await saveSessionState(state);

    this.scheduleInactivityTimeout();
  }

  private scheduleInactivityTimeout(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
    }
    this.inactivityTimeoutId = setTimeout(() => this.expireSession(), SESSION_EXPIRATION_DELAY);
  }

  private scheduleSessionTimeout(createdAt: number): void {
    const now = Date.now();
    const remainingTime = SESSION_TIME_OUT_DELAY - (now - createdAt);
    if (remainingTime > 0) {
      this.sessionTimeoutId = setTimeout(() => this.expireSession(), remainingTime);
    } else {
      this.expireSession();
    }
  }

  private clearTimers(): void {
    if (this.inactivityTimeoutId !== undefined) {
      clearTimeout(this.inactivityTimeoutId);
      this.inactivityTimeoutId = undefined;
    }
    if (this.sessionTimeoutId !== undefined) {
      clearTimeout(this.sessionTimeoutId);
      this.sessionTimeoutId = undefined;
    }
  }

  // TODO(RUM-14514): attach session that was active at the time of the event start
  private registerHooks() {
    this.hooks.registerRum(() => ({
      session: { id: this.currentSession.id },
    }));

    this.hooks.registerTelemetry(() => ({
      session: { id: this.currentSession.id },
    }));
  }
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
    displayError('Failed to save session state:', error);
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
