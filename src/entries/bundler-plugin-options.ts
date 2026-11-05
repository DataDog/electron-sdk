export interface DatadogBundlerPluginOptions {
  /**
   * Bundle the SDK into the application and emit instrumentation, preload, and tracer assets.
   * SDK and tracer package trees are not copied, regardless of copyRuntimeDependencies.
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
