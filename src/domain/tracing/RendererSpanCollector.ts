import * as DiagnosticsChannel from 'node:diagnostics_channel';
import { ipcMain } from 'electron';
import { type ServerDuration } from '@datadog/browser-core';
import { type ExportedSpan } from './SpanProcessor';
import { type NsTimeStamp } from './rawTracingData.types';

interface RendererSpanMetadata {
  type: 'renderer.invoke' | 'renderer.receive';
  channel: string;
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  startTime: number;
  endTime: number;
  pid: number;
  error?: boolean;
  rumContext?: string;
}

const DD_TRACE_SPAN_CHANNEL = 'datadog:apm:electron:export';
const RENDERER_SPAN_IPC_CHANNEL = 'datadog:apm:renderer:span';

export class RendererSpanCollector {
  private readonly exportChannel = DiagnosticsChannel.channel(DD_TRACE_SPAN_CHANNEL);
  private readonly handler: (event: Electron.IpcMainEvent, metadata: RendererSpanMetadata) => void;

  constructor() {
    this.handler = (_event, metadata) => {
      this.onRendererSpan(metadata);
    };
    ipcMain.on(RENDERER_SPAN_IPC_CHANNEL, this.handler);
  }

  private onRendererSpan(meta: RendererSpanMetadata): void {
    if (!this.exportChannel.hasSubscribers) return;

    const rumContext = meta.rumContext ? tryParse(meta.rumContext) : undefined;
    const span = buildExportedSpan(meta, rumContext);
    this.exportChannel.publish([[span]]);
  }

  stop(): void {
    ipcMain.off(RENDERER_SPAN_IPC_CHANNEL, this.handler);
  }
}

function buildExportedSpan(meta: RendererSpanMetadata, rumContext: Record<string, unknown> | undefined): ExportedSpan {
  const makeId = (hex: string) => {
    const padded = hex.padStart(16, '0');
    return {
      toString: (radix = 10) => (radix === 16 ? padded : BigInt('0x' + padded).toString(10)),
    };
  };

  const spanMeta: Record<string, string> = {
    component: 'electron',
    'span.kind': meta.type === 'renderer.receive' ? 'consumer' : 'producer',
    'renderer.pid': String(meta.pid),
  };

  const view = (rumContext as { view?: { id?: string } } | undefined)?.view;
  const userAction = (rumContext as { user_action?: { id?: string | string[] } } | undefined)?.user_action;
  if (view?.id) spanMeta['_dd.view.id'] = view.id;
  if (userAction?.id) {
    const actionId = userAction.id;
    // user_action.id can be an array when the rage-click detection clone is active alongside
    // the original click. The original click (last element, inserted first into the history)
    // is the one that produces the intake action event — use it for span linking.
    spanMeta['_dd.action.id'] = Array.isArray(actionId) ? actionId[actionId.length - 1] : actionId;
  }

  return {
    trace_id: makeId(meta.traceId),
    span_id: makeId(meta.spanId),
    parent_id: makeId(meta.parentSpanId ?? '0'),
    name: meta.type === 'renderer.receive' ? 'electron.renderer.receive' : 'electron.renderer.invoke',
    service: '',
    resource: meta.channel,
    type: 'worker',
    error: meta.error ? 1 : 0,
    meta: spanMeta,
    metrics: {},
    start: Math.round(meta.startTime * 1_000_000) as NsTimeStamp,
    duration: Math.round((meta.endTime - meta.startTime) * 1_000_000) as ServerDuration,
  };
}

function tryParse(json: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
