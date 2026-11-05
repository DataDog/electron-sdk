export interface DatadogBundlerPluginOptions {
  /**
   * Copy the SDK and its runtime dependencies into the build output.
   *
   * Prefer configuring the application packager to stage external dependencies. Enable this
   * compatibility fallback only when the packager cannot do so.
   *
   * @default false
   */
  copyRuntimeDependencies?: boolean;
}
