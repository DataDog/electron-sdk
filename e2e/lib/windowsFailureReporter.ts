import type { Reporter, TestCase, TestResult } from '@playwright/test/reporter';

/** Prints failures as they happen, even if the runner is terminated before the final report. */
export default class WindowsFailureReporter implements Reporter {
  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === test.expectedStatus || result.status === 'skipped') return;
    console.error(`[windows-failure] ${test.titlePath().join(' > ')} (${result.status})`);
    for (const error of result.errors) {
      console.error(error.stack ?? error.message ?? error.value ?? 'Unknown test error');
    }
    for (const attachment of result.attachments) {
      if (attachment.path) console.error(`[windows-failure] ${attachment.name}: ${attachment.path}`);
    }
  }
}
