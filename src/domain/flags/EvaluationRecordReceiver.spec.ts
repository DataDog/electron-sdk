import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { addErrorMock, addDebugMock } = vi.hoisted(() => ({
  addErrorMock: vi.fn(),
  addDebugMock: vi.fn(),
}));

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { ipcMain: new EventEmitter() };
});

vi.mock('../telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../telemetry')>()),
  addError: addErrorMock,
  addDebug: addDebugMock,
}));

import {
  EvaluationRecordReceiver,
  MAX_BATCH_JSON_LENGTH,
  DROPPED_RECORDS_DEBUG_INTERVAL,
  DROPPED_RECORDS_DEBUG_MESSAGE,
} from './EvaluationRecordReceiver';
import { ExposureCollector } from './ExposureCollector';
import { FlagsState } from './FlagsState';
import type { EvaluationRecord } from '../../common/flags/types';
import type { ServerEvent } from '../../event';
import { ipcMain } from 'electron';

const validRecord: EvaluationRecord = {
  flagKey: 'targeted-flag',
  variant: 'variant-a',
  allocationKey: 'targeted-pro',
  reason: 'TARGETING_MATCH',
  doLog: true,
  serialId: 1,
  configurationId: 'config-1',
  contextRevision: 0,
  timestamp: 100 as never,
};

function createReceiver() {
  const records: EvaluationRecord[] = [];
  const receiver = new EvaluationRecordReceiver({
    onRecord: (record) => records.push(record),
    isAllowedSender: (frame) => frame?.origin === 'https://app.example.com',
  });
  receiver.start();
  return { receiver, records };
}

function send(json: unknown, origin = 'https://app.example.com') {
  ipcMain.emit('datadog:flags-evaluations', { senderFrame: { origin, url: `${origin}/` } }, json);
}

describe('EvaluationRecordReceiver', () => {
  let receiver: EvaluationRecordReceiver | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
    addErrorMock.mockClear();
    addDebugMock.mockClear();
  });

  afterEach(() => {
    receiver?.stop();
    receiver = undefined;
    vi.useRealTimers();
  });

  it('accepts batches only from senders allowed by the origin check', () => {
    const created = createReceiver();
    receiver = created.receiver;
    send(JSON.stringify({ records: [validRecord] }), 'https://evil.com');
    expect(created.records).toHaveLength(0);
    expect(addDebugMock).not.toHaveBeenCalled();
    send(JSON.stringify({ records: [validRecord] }));
    expect(created.records).toEqual([validRecord]);
  });

  it.each([
    ['an oversize payload (rejected before parsing)', () => 'x'.repeat(MAX_BATCH_JSON_LENGTH + 1)],
    ['a non-JSON payload', () => '{not json'],
    ['a payload without a records array', () => JSON.stringify({ records: 'nope' })],
    ['a non-string payload', () => ({ records: [validRecord] })],
  ])('drops %s whole and reports it as one dropped record', (_label, payload) => {
    const created = createReceiver();
    receiver = created.receiver;
    send(payload());
    expect(created.records).toHaveLength(0);
    expect(addDebugMock).toHaveBeenCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 1 });
  });

  it('caps a batch at the first 100 records and reports the remainder in the dropped-record count', () => {
    const created = createReceiver();
    receiver = created.receiver;
    send(JSON.stringify({ records: Array.from({ length: 130 }, () => validRecord) }));
    expect(created.records).toHaveLength(100);
    expect(addDebugMock).toHaveBeenCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 30 });
  });

  it('forwards valid records, drops invalid ones with one count-only telemetry debug per batch', () => {
    const created = createReceiver();
    receiver = created.receiver;
    send(JSON.stringify({ records: [validRecord, { ...validRecord, flagKey: 42 }, { ...validRecord, doLog: 'yes' }] }));
    expect(created.records).toEqual([validRecord]);
    expect(addDebugMock).toHaveBeenCalledTimes(1);
    expect(addDebugMock).toHaveBeenCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 2 });
  });

  it('rate-limits dropped-record telemetry to one per 10 s and accumulates the counts in between', () => {
    const created = createReceiver();
    receiver = created.receiver;
    const invalidBatch = JSON.stringify({ records: [{ ...validRecord, flagKey: 42 }] });
    send(invalidBatch);
    send(invalidBatch);
    send(invalidBatch);
    expect(addDebugMock).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DROPPED_RECORDS_DEBUG_INTERVAL);
    send(invalidBatch);
    expect(addDebugMock).toHaveBeenCalledTimes(2);
    expect(addDebugMock).toHaveBeenLastCalledWith(DROPPED_RECORDS_DEBUG_MESSAGE, { count: 3 });
  });

  it('forwards at most 5 batch.errors to addTelemetryError with message and stack each truncated to 1024 chars', () => {
    const created = createReceiver();
    receiver = created.receiver;
    const errors = Array.from({ length: 7 }, (_, index) => ({
      message: `${index}${'m'.repeat(1200)}`,
      stack: `${index}${'s'.repeat(1200)}`,
    }));
    send(JSON.stringify({ records: [], errors }));
    expect(addErrorMock).toHaveBeenCalledTimes(5);
    const forwarded = addErrorMock.mock.calls.map((call) => call[0] as Error);
    expect(forwarded.map((error) => error.message[0])).toEqual(['0', '1', '2', '3', '4']);
    for (const error of forwarded) {
      expect(error.name).toBe('RendererFlagsError');
      expect(error.message).toHaveLength(1024);
      expect(error.stack).toHaveLength(1024);
      expect(error.stack!.startsWith(error.message[0])).toBe(true);
    }
  });

  it('same tuple from main and a renderer emits exactly one exposure through the real collector', () => {
    const state = new FlagsState({ targetingKey: 'user-pro', plan: 'pro' });
    const exposures: ServerEvent[] = [];
    const collector = new ExposureCollector(state, { applicationId: 'app-id' }, (event) => exposures.push(event));
    receiver = new EvaluationRecordReceiver({
      onRecord: (record) => collector.add(record),
      isAllowedSender: () => true,
    });
    receiver.start();
    collector.add(validRecord);
    send(JSON.stringify({ records: [{ ...validRecord, timestamp: 200, viewUrl: 'app://index.html' }] }));
    expect(exposures).toHaveLength(1);
    send(JSON.stringify({ records: [{ ...validRecord, variant: 'variant-b' }] }));
    expect(exposures).toHaveLength(2);
  });

  it('stop() removes the IPC listener', () => {
    const created = createReceiver();
    created.receiver.stop();
    expect(ipcMain.listenerCount('datadog:flags-evaluations')).toBe(0);
    send(JSON.stringify({ records: [validRecord] }));
    expect(created.records).toHaveLength(0);
  });
});
