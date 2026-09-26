export interface DatadogBundlerPluginOptions {
  /**
   * Copy the SDK, dd-trace, and their runtime dependencies into the build output.
   *
   * Prefer configuring the application packager to stage external dependencies. Enable this
   * compatibility fallback only when the packager cannot do so.
   *
   * @default false
   */
  copyRuntimeDependencies?: boolean;
}
