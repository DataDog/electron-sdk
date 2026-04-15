import { test, expect, flushTransport } from './helpers';
import type { RumResourceEvent } from '@datadog/electron-sdk';

function filterResources(events: { body: unknown }[], urlPattern: string): { body: unknown }[] {
  return events.filter((e) => (e.body as RumResourceEvent).resource.url.includes(urlPattern));
}

test('spawn ls produces exactly one resource event', async ({ window, intake }) => {
  await window.click('#spawn-ls');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const lsResources = filterResources(resources, 'spawn://ls');

  expect(lsResources).toHaveLength(1);
  const body = lsResources[0].body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(0);
  expect(body.resource.duration).toBeGreaterThan(0);
});

test('exec echo produces exactly one resource event', async ({ window, intake }) => {
  await window.click('#exec-echo');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const echoResources = filterResources(resources, 'echo hello world');

  expect(echoResources).toHaveLength(1);
  const body = echoResources[0].body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(0);
});

test('spawn fail produces exactly one resource event with error', async ({ window, intake }) => {
  await window.click('#spawn-fail');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const failResources = filterResources(resources, 'nonexistent-command-xyz');

  expect(failResources).toHaveLength(1);
  const body = failResources[0].body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(-1);
});

test('exec timeout produces exactly one resource event with error', async ({ window, intake }) => {
  await window.click('#exec-timeout');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const timeoutResources = filterResources(resources, 'sleep 10');

  expect(timeoutResources).toHaveLength(1);
  const body = timeoutResources[0].body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).not.toBe(0);
});
