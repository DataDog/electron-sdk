import { test, expect, flushTransport } from './helpers';
import type { RumResourceEvent } from '@datadog/electron-sdk';

test('spawn ls produces a resource event', async ({ window, intake }) => {
  await window.click('#spawn-ls');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const lsResource = resources.find((e) => (e.body as RumResourceEvent).resource.url === 'child_process://ls');

  expect(lsResource).toBeDefined();
  const body = lsResource!.body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(0);
  expect(body.resource.duration).toBeGreaterThan(0);
});

test('exec echo produces a resource event', async ({ window, intake }) => {
  await window.click('#exec-echo');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const echoResource = resources.find((e) => (e.body as RumResourceEvent).resource.url.includes('echo hello world'));

  expect(echoResource).toBeDefined();
  const body = echoResource!.body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(0);
});

test('spawn fail produces a resource event with error', async ({ window, intake }) => {
  await window.click('#spawn-fail');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const failResource = resources.find((e) =>
    (e.body as RumResourceEvent).resource.url.includes('nonexistent-command-xyz')
  );

  expect(failResource).toBeDefined();
  const body = failResource!.body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  expect(body.resource.status_code).toBe(-1);
});

test('exec timeout produces a resource event with error', async ({ window, intake }) => {
  await window.click('#exec-timeout');
  await window.waitForTimeout(1000);
  await flushTransport(window);

  const resources = await intake.getEventsByType('resource', 10_000);
  const timeoutResource = resources.find((e) => (e.body as RumResourceEvent).resource.url.includes('sleep 10'));

  expect(timeoutResource).toBeDefined();
  const body = timeoutResource!.body as RumResourceEvent;
  expect(body.resource.type).toBe('native');
  // Killed processes get a non-zero status
  expect(body.resource.status_code).not.toBe(0);
});
