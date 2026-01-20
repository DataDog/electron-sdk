import { test, expect } from '../lib/helpers';

test('SDK initialization', async ({ window }) => {
  // Click "Initialize SDK" button
  const initBtn = window.locator('#init-btn');
  await initBtn.click();

  // Wait for result to be displayed
  const resultDiv = window.locator('#result');
  await expect(resultDiv).toHaveText('true');

  // Verify success styling applied
  await expect(resultDiv).toHaveClass('success');
});
