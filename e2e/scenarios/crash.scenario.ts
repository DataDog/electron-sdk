import { test, expect, launchAppManually, createUserDataDir, cleanupUserDataDir } from '../lib/helpers';

test('emits a crash error event after a native crash', async ({ intake }) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: Launch and crash
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();
  const viewEvents = await intake.getEventsByType('view');
  const sessionId = viewEvents[0].body.session.id;

  const appClosed = firstElectronApp.waitForEvent('close');
  firstMainPage.crash();
  await appClosed;
  intake.clear();

  // Phase 2: Relaunch and verify crash event
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    // increase timeout to account for crash dump processing
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body;
    expect(error.session.id).toBe(sessionId);
    expect(error.error.is_crash).toBe(true);
    expect(error.error.source).toBe('source');
    expect(error.error.handling).toBe('unhandled');
    expect(error.error.category).toBe('Exception');
    expect(error.error.stack).toBeTruthy();
    expect(error.error.threads).toBeDefined();
    expect(error.error.binary_images).toBeDefined();
    expect(error.error.meta).toBeDefined();
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

test('crash error event carries user and account context set before the crash', async ({ intake }) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: Launch, set user/account context, then crash
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir);
  await firstMainPage.flushTransport();

  await firstMainPage.setUserInfo({ id: 'crash-user', name: 'Alice' });
  await firstMainPage.setAccountInfo({ id: 'crash-account', name: 'Acme Corp' });

  const appClosed = firstElectronApp.waitForEvent('close');
  firstMainPage.crash();
  await appClosed;
  intake.clear();

  // Phase 2: Relaunch and verify the crash event is enriched with the pre-crash context
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir);
  try {
    await secondMainPage.flushTransport();
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    const error = errorEvents[0].body;

    expect(error.error.is_crash).toBe(true);
    expect(error.usr).toMatchObject({ id: 'crash-user', name: 'Alice' });
    expect(error.account).toMatchObject({ id: 'crash-account', name: 'Acme Corp' });
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});

interface ExecutionContext {
  id: string;
  type: 'main-process' | 'renderer-process';
}

test('crash error event carries the execution_context of the process that actually crashed, not the relaunched one', async ({
  intake,
}) => {
  const userDataDir = await createUserDataDir();

  // Phase 1: launch with execution-context tracking on, capture its main-process
  // execution_context id, then crash
  const { electronApp: firstElectronApp, mainPage: firstMainPage } = await launchAppManually(intake, userDataDir, {
    enableExecutionContext: true,
  });
  await firstMainPage.flushTransport();
  const firstMainEvent = (await intake.getEventsByType('execution_context')).find(
    (e) => (e.body.execution_context as ExecutionContext).type === 'main-process'
  );
  const firstMainExecutionContextId = (firstMainEvent!.body.execution_context as ExecutionContext).id;

  const appClosed = firstElectronApp.waitForEvent('close');
  firstMainPage.crash();
  await appClosed;
  intake.clear();

  // Phase 2: relaunch (a new main-process execution context is generated) and verify the replayed
  // crash error still carries the FIRST run's execution_context, not the second run's
  const { electronApp: secondElectronApp, mainPage: secondMainPage } = await launchAppManually(intake, userDataDir, {
    enableExecutionContext: true,
  });
  try {
    await secondMainPage.flushTransport();

    const secondMainEvent = (await intake.getEventsByType('execution_context')).find(
      (e) => (e.body.execution_context as ExecutionContext).type === 'main-process'
    );
    expect((secondMainEvent!.body.execution_context as ExecutionContext).id).not.toBe(firstMainExecutionContextId);

    // increase timeout to account for crash dump processing
    const errorEvents = await intake.getEventsByType('error', { timeout: 15_000 });
    expect(errorEvents).toHaveLength(1);

    const error = errorEvents[0].body;
    const errorExecutionContext = (error as unknown as { execution_context?: ExecutionContext }).execution_context;
    expect(error.error.is_crash).toBe(true);
    expect(errorExecutionContext).toBeDefined();
    expect(errorExecutionContext!.type).toBe('main-process');
    expect(errorExecutionContext!.id).toBe(firstMainExecutionContextId);
  } finally {
    await secondElectronApp.close();
    await cleanupUserDataDir(userDataDir);
  }
});
