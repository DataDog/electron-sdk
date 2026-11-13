export interface DatadogBundlerPluginOptions {
  /**
   * Use the SDK's embedded tracer instead of loading dd-trace-electron from node_modules.
   * With copyRuntimeDependencies enabled, the tracer package tree is not copied.
   * The package remains a runtime dependency; application packagers may still include it.
   *
   * @default false
   * @example
   * datadogVitePlugin({ bundledMode: true })
   */
  bundledMode?: boolean;

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
