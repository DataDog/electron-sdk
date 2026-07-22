import { app } from 'electron';
import { elapsed, ONE_MINUTE, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, type EventManager, type LifecycleEvent, LifecycleKind } from '../../../event';
import { setInterval } from '../../telemetry';
import { ProcessContext } from './ProcessContext';
import type { RawRumProcess } from '../rawRumData.types';

export const PROCESS_UPDATE_INTERVAL = ONE_MINUTE;

interface ProcessState {
  id: string;
  startTime: TimeStamp;
  documentVersion: number;
  pid: number;
  name?: string;
  timerId: ReturnType<typeof setInterval>;
}

export class ProcessCollection {
  readonly processContext: ProcessContext;
  private mainState!: ProcessState;
  private readonly rendererStates = new Map<number, ProcessState>();

  private constructor(private readonly eventManager: EventManager) {
    const mainId = generateUUID();
    this.processContext = new ProcessContext({ id: mainId, name: undefined });
  }

  static start(eventManager: EventManager): ProcessCollection {
    const collection = new ProcessCollection(eventManager);
    collection.initMain();
    collection.initRendererTracking();
    return collection;
  }

  private initMain(): void {
    const mainId = this.processContext.getMainProcessContext().id;
    const startTime = timeStampNow();
    const timerId = setInterval(() => {
      this.mainState.documentVersion++;
      this.emitProcessEvent({
        id: mainId,
        role: 'main',
        pid: process.pid,
        name: undefined,
        startTime: this.mainState.startTime,
        documentVersion: this.mainState.documentVersion,
      });
    }, PROCESS_UPDATE_INTERVAL);

    this.mainState = { id: mainId, startTime, documentVersion: 1, pid: process.pid, name: undefined, timerId };

    this.emitProcessEvent({
      id: mainId,
      role: 'main',
      pid: process.pid,
      name: undefined,
      startTime,
      documentVersion: 1,
    });

    this.eventManager.registerHandler<LifecycleEvent>({
      canHandle: (event): event is LifecycleEvent => event.kind === EventKind.LIFECYCLE,
      handle: (event) => {
        if (event.lifecycle === LifecycleKind.SESSION_EXPIRED) {
          clearInterval(this.mainState.timerId);
          this.mainState.documentVersion++;
          this.emitProcessEvent({
            id: this.mainState.id,
            role: 'main',
            pid: this.mainState.pid,
            name: undefined,
            startTime: this.mainState.startTime,
            documentVersion: this.mainState.documentVersion,
          });
        }
      },
    });
  }

  private initRendererTracking(): void {
    app.on('web-contents-created', (_event, webContents) => {
      const webContentsId = webContents.id;
      const pid = webContents.getProcessId();
      const id = generateUUID();
      const startTime = timeStampNow();

      this.processContext.setRendererProcess(webContentsId, { id, name: undefined });

      const timerId = setInterval(() => {
        const state = this.rendererStates.get(webContentsId);
        if (!state) return;
        state.documentVersion++;
        this.emitProcessEvent({
          id,
          role: 'renderer',
          pid,
          name: undefined,
          startTime: state.startTime,
          documentVersion: state.documentVersion,
        });
      }, PROCESS_UPDATE_INTERVAL);

      const state: ProcessState = { id, startTime, documentVersion: 1, pid, name: undefined, timerId };
      this.rendererStates.set(webContentsId, state);

      this.emitProcessEvent({ id, role: 'renderer', pid, name: undefined, startTime, documentVersion: 1 });

      const endRenderer = (exitReason?: string) => {
        const s = this.rendererStates.get(webContentsId);
        if (!s) return;
        clearInterval(s.timerId);
        s.documentVersion++;
        this.emitProcessEvent({
          id,
          role: 'renderer',
          pid,
          name: undefined,
          startTime: s.startTime,
          documentVersion: s.documentVersion,
          exitReason,
        });
        this.rendererStates.delete(webContentsId);
        this.processContext.deleteRendererProcess(webContentsId);
      };

      webContents.on('destroyed', () => endRenderer(undefined));
      webContents.on('render-process-gone', (_e, details) => endRenderer(details.reason));
    });
  }

  private emitProcessEvent(params: {
    id: string;
    role: 'main' | 'renderer';
    pid: number;
    name?: string;
    startTime: TimeStamp;
    documentVersion: number;
    exitReason?: string;
  }): void {
    const isStart = params.documentVersion === 1;
    const data: RawRumProcess = {
      type: 'process',
      date: params.startTime,
      process: {
        id: params.id,
        role: params.role,
        pid: params.pid,
        name: params.name,
        ...(!isStart && { duration: toServerDuration(elapsed(params.startTime, timeStampNow())) }),
        ...(params.exitReason !== undefined && { exit_reason: params.exitReason }),
      },
      _dd: { document_version: params.documentVersion },
    };

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: params.startTime,
    });
  }
}
