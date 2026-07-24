export interface DatadogBundlerPluginOptions {
  /**
   * Copy the SDK, dd-trace, and their runtime dependencies into the build output.
   *
   * Disable this when the application packager stages external dependencies.
   *
   * @default true
   */
  copyRuntimeDependencies?: boolean;
}
