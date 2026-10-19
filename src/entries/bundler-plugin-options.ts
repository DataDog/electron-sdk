export interface DatadogBundlerPluginOptions {
  /**
   * Copy dd-trace and its runtime dependencies into the build output.
   *
   * The SDK instrumentation and preload assets are always emitted by the plugin.
   * Disable this option when the application packager stages external dependencies.
   *
   * @default true
   */
  copyRuntimeDependencies?: boolean;
}
