import type { RumViewEvent, RumVitalDurationEvent } from '@datadog/electron-sdk';
import { expect, test } from '../lib/helpers';

test('emits custom duration vitals from the main process', async ({ mainPage, intake }) => {
  await mainPage.flushTransport();
  const view = (await intake.getEventsByType('view'))[0].body as RumViewEvent;

  const directStartTime = Date.now();
  await mainPage.addDurationVital('database.migration', {
    startTime: directStartTime,
    duration: 1_234,
    context: { migration: 'users' },
    description: 'initial migration',
  });

  await mainPage.startDurationVital('document.open', { vitalKey: 'document-1' });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mainPage.stopDurationVital('document.open', {
    vitalKey: 'document-1',
    context: { source: 'menu' },
  });
  await mainPage.flushTransport();

  const vitals = (await intake.waitForEventCount('vital', 2)).map((event) => event.body as RumVitalDurationEvent);
  const direct = vitals.find((vital) => vital.vital?.name === 'database.migration')!;
  const measured = vitals.find((vital) => vital.vital?.name === 'document.open')!;

  expect(direct.vital?.type).toBe('duration');
  expect(direct.vital?.duration).toBe(1_234_000_000);
  expect(direct.vital?.description).toBe('initial migration');
  expect(direct.context).toEqual({ migration: 'users' });
  expect(direct.date).toBe(directStartTime);

  expect(measured.vital?.duration).toBeGreaterThan(0);
  expect(measured.context).toEqual({ source: 'menu' });
  expect(measured.vital).not.toHaveProperty('vital_key');

  expect(direct.session.id).toBe(view.session.id);
  expect(direct.application.id).toBe(view.application.id);
  expect(direct.view.id).toBe(view.view.id);
  expect(direct.source).toBe('electron');
  expect(direct._dd.format_version).toBe(2);
});
