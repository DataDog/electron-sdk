import { test, expect, flushTransport } from './helpers';

// Step 1: verify a RUM view event reaches intake at app launch.
test('app launch: intake receives a view event', async ({ window, intake }) => {
  await flushTransport(window);
  const view = await intake.getEventsByType('view', { timeout: 15_000 });
  expect(view.length).toBeGreaterThan(0);
});

// Step 2: clicking "Main process fetch (https)" triggers an APM trace/resource at intake.
test('main fetch: intake receives an APM span for the HTTPS request', async ({ window, intake }) => {
  // Establish session first so SpanProcessor doesn't discard spans.
  await flushTransport(window);
  await intake.getEventsByType('view', { timeout: 15_000 });
  intake.clear();

  await window.click('#main-fetch');

  // Give the request time to complete, then flush.
  await window.waitForTimeout(2_000);
  await flushTransport(window);

  const span = await intake.waitForSpan(
    (s) =>
      (s.name === 'http.request' || s.name === 'https.request') &&
      (s.meta?.['http.url'] as string | undefined)?.includes('httpbin.org') === true,
    { timeout: 10_000 }
  );
  expect(span.meta?.['http.url']).toContain('httpbin.org');
});
