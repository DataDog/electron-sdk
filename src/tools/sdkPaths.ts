import { app } from 'electron';

/** The only place the SDK reads system paths, so that every path the SDK knows about can be scrubbed from payloads. */
export const sdkPaths = {
  appPath: () => app.getAppPath(),
  userData: () => app.getPath('userData'),
  crashDumps: () => app.getPath('crashDumps'),
};

export type SdkPaths = typeof sdkPaths;
export type SdkPathName = keyof SdkPaths;
