import { DatadogCoreProvider, configurationFromString } from '@datadog/openfeature-browser/rules-based';
import { ErrorCode } from '@openfeature/web-sdk';
import type { EvaluationDetails, FlagValueType, Logger } from '@openfeature/web-sdk';
import type { FlagsSnapshot, FlatContext } from './types';

const noopLogger: Logger = {
  error: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  info: () => undefined,
};

/**
 * Local, synchronous flag evaluation over `DatadogCoreProvider`, fed by snapshots.
 * Each process owns one evaluator; renderers parse the serialized configuration from
 * their snapshot with `configurationFromString`, so parity with the fetch path is
 * guaranteed by construction.
 */
export class FlagsEvaluator {
  private provider?: DatadogCoreProvider;
  private context?: FlatContext;
  private revision = -1;
  private appliedContextRevision: number | undefined;

  /**
   * Apply a snapshot. Returns `true` when the snapshot was newer than the current one
   * and was applied, `false` when it was ignored. A snapshot without a configuration
   * keeps the current configuration and only updates the context.
   */
  apply(snapshot: FlagsSnapshot): boolean {
    if (snapshot.revision <= this.revision) {
      return false;
    }
    this.revision = snapshot.revision;
    if (snapshot.configuration === undefined && snapshot.status === 'ERROR') {
      // An authoritative failure drops the served configuration: evaluations return the
      // application default with an error code until a later successful fetch (D5).
      this.provider = undefined;
      this.context = undefined;
      this.appliedContextRevision = snapshot.contextRevision;
      return true;
    }
    if (snapshot.configuration !== undefined) {
      const provider = this.provider ?? new DatadogCoreProvider();
      this.provider = provider;
      provider.setConfiguration(configurationFromString(snapshot.configuration));
    }
    if (snapshot.context !== undefined) {
      this.setContext(snapshot.context);
      this.appliedContextRevision = snapshot.contextRevision;
    }
    return true;
  }

  private setContext(context: FlatContext) {
    const provider = this.provider;
    if (provider === undefined) {
      this.context = context;
      return;
    }
    if (this.context === undefined) {
      // initialize() sets the provider context even when it rejects (no configuration).
      provider.initialize(context).catch(() => undefined);
    } else {
      try {
        provider.onContextChange(this.context, context);
      } catch {
        // onContextChange sets the context before validating: an invalid configuration
        // keeps serving defaults with an error code, the context is still tracked.
      }
    }
    this.context = context;
  }

  /**
   * Evaluate a flag synchronously against the applied snapshot. Returns the
   * application default with `PROVIDER_NOT_READY` before any snapshot is applied.
   */
  resolve<T extends FlagValueType>(type: T, flagKey: string, defaultValue: unknown): EvaluationDetails<T> {
    if (this.provider === undefined || this.context === undefined) {
      return {
        flagKey,
        value: defaultValue as never,
        reason: 'ERROR',
        errorCode: ErrorCode.PROVIDER_NOT_READY,
        flagMetadata: {},
      };
    }
    const context = this.context;
    let result;
    switch (type) {
      case 'boolean':
        result = this.provider.resolveBooleanEvaluation(flagKey, defaultValue as boolean, context, noopLogger);
        break;
      case 'string':
        result = this.provider.resolveStringEvaluation(flagKey, defaultValue as string, context, noopLogger);
        break;
      case 'number':
        result = this.provider.resolveNumberEvaluation(flagKey, defaultValue as number, context, noopLogger);
        break;
      case 'object':
        result = this.provider.resolveObjectEvaluation(flagKey, defaultValue as never, context, noopLogger);
        break;
    }
    return { flagKey, flagMetadata: {}, ...result } as EvaluationDetails<T>;
  }

  /**
   * The `contextRevision` of the context evaluations currently use. Hooks capture it at
   * resolution time so a record always carries the revision it was evaluated with (D8).
   */
  get contextRevision(): number | undefined {
    return this.appliedContextRevision;
  }

  /** Release the provider. Subsequent resolves return the default with `PROVIDER_NOT_READY`. */
  stop(): void {
    this.provider = undefined;
    this.context = undefined;
    this.revision = -1;
    this.appliedContextRevision = undefined;
  }
}
