export interface DatadogBundlerPluginOptions {
  /**
   * Copy the SDK, dd-trace-electron, and their runtime dependencies into the build output.
   *
   * Prefer configuring the application packager to stage external dependencies. Enable this
   * compatibility fallback only when the packager cannot do so.
   * Missing or uncopyable required dependencies fail the build.
   *
   * @default false
   * @example
   * { copyRuntimeDependencies: true }
   */
  copyRuntimeDependencies?: boolean;
}
