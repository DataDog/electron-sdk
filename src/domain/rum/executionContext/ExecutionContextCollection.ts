import { app } from 'electron';
import { elapsed, ONE_MINUTE, timeStampNow, toServerDuration, type TimeStamp } from '@datadog/js-core/time';
import { generateUUID } from '@datadog/browser-core';
import { EventFormat, EventKind, type EventManager, type LifecycleEvent, LifecycleKind } from '../../../event';
import { setInterval } from '../../telemetry';
import { display } from '../../../tools/display';
import { ExecutionContextAttributes } from './ExecutionContextAttributes';
import type { RawRumExecutionContext } from '../rawRumData.types';

export const PROCESS_UPDATE_INTERVAL = ONE_MINUTE;

interface ExecutionContextState {
  id: string;
  startTime: TimeStamp;
  documentVersion: number;
  pid: number;
  name?: string;
  timerId: ReturnType<typeof setInterval>;
}

export class ExecutionContextCollection {
  readonly executionContextAttributes: ExecutionContextAttributes;
  private mainState!: ExecutionContextState;
  private readonly rendererStates = new Map<number, ExecutionContextState>();

  private constructor(private readonly eventManager: EventManager) {
    const mainId = generateUUID();
    this.executionContextAttributes = new ExecutionContextAttributes({ id: mainId, name: undefined });
  }

  static start(eventManager: EventManager): ExecutionContextCollection {
    const collection = new ExecutionContextCollection(eventManager);
    collection.initMain();
    collection.initRendererTracking();
    return collection;
  }

  private initMain(): void {
    const mainId = this.executionContextAttributes.getMainExecutionContext().id;
    const startTime = timeStampNow();
    const timerId = setInterval(() => {
      this.mainState.documentVersion++;
      this.emitExecutionContextEvent({
        id: mainId,
        type: 'main-process',
        pid: process.pid,
        name: undefined,
        startTime: this.mainState.startTime,
        documentVersion: this.mainState.documentVersion,
      });
    }, PROCESS_UPDATE_INTERVAL);

    this.mainState = { id: mainId, startTime, documentVersion: 1, pid: process.pid, name: undefined, timerId };

    this.emitExecutionContextEvent({
      id: mainId,
      type: 'main-process',
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
          this.emitExecutionContextEvent({
            id: this.mainState.id,
            type: 'main-process',
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

      this.executionContextAttributes.setRendererExecutionContext(webContentsId, { id, name: undefined });

      const timerId = setInterval(() => {
        const state = this.rendererStates.get(webContentsId);
        if (!state) return;
        state.documentVersion++;
        this.emitExecutionContextEvent({
          id,
          type: 'renderer-process',
          pid,
          name: undefined,
          startTime: state.startTime,
          documentVersion: state.documentVersion,
        });
      }, PROCESS_UPDATE_INTERVAL);

      const state: ExecutionContextState = { id, startTime, documentVersion: 1, pid, name: undefined, timerId };
      this.rendererStates.set(webContentsId, state);

      this.emitExecutionContextEvent({
        id,
        type: 'renderer-process',
        pid,
        name: undefined,
        startTime,
        documentVersion: 1,
      });

      const endRenderer = (exitReason?: string) => {
        const s = this.rendererStates.get(webContentsId);
        if (!s) return;
        clearInterval(s.timerId);
        s.documentVersion++;
        this.emitExecutionContextEvent({
          id,
          type: 'renderer-process',
          pid,
          name: undefined,
          startTime: s.startTime,
          documentVersion: s.documentVersion,
          exitReason,
        });
        this.rendererStates.delete(webContentsId);
        this.executionContextAttributes.deleteRendererExecutionContext(webContentsId);
      };

      webContents.on('destroyed', () => endRenderer(undefined));
      webContents.on('render-process-gone', (_e, details) => endRenderer(details.reason));
    });
  }

  private emitExecutionContextEvent(params: {
    id: string;
    type: 'main-process' | 'renderer-process';
    pid: number;
    name?: string;
    startTime: TimeStamp;
    documentVersion: number;
    exitReason?: string;
  }): void {
    const isStart = params.documentVersion === 1;
    const data: RawRumExecutionContext = {
      type: 'execution_context',
      date: params.startTime,
      execution_context: {
        id: params.id,
        type: params.type,
        pid: params.pid,
        name: params.name,
        ...(!isStart && { duration: toServerDuration(elapsed(params.startTime, timeStampNow())) }),
        ...(params.exitReason !== undefined && { exit_reason: params.exitReason }),
      },
      _dd: { document_version: params.documentVersion },
    };

    const lifecycle = params.documentVersion === 1 ? 'start' : params.exitReason !== undefined ? 'end' : 'update';
    display.log(`execution_context event (${lifecycle}):`, JSON.stringify(data.execution_context));

    this.eventManager.notify({
      kind: EventKind.RAW,
      format: EventFormat.RUM,
      data,
      startTime: params.startTime,
    });
  }
}
