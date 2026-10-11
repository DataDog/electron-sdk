import { DatadogCoreProvider, configurationFromString } from '@datadog/openfeature-browser/rules-based';
import { evaluatePrecomputedConfiguration, type FlagsConfiguration } from '@datadog/flagging-core';
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
 * Local, synchronous flag evaluation, fed by snapshots. The decoded configuration
 * capability selects the evaluator (M7): a precomputed capability is evaluated with the
 * upstream `evaluatePrecomputedConfiguration` (the exact function the upstream
 * `DatadogProvider` resolves with) against the snapshot context — the context the
 * assignments were computed for — while a rules capability keeps using
 * `DatadogCoreProvider`. Each process owns one evaluator; renderers and children parse
 * the serialized configuration from their snapshot with `configurationFromString`, so
 * parity with the fetch path is guaranteed by construction.
 */
export class FlagsEvaluator {
  private provider?: DatadogCoreProvider;
  private precomputed?: FlagsConfiguration;
  private context?: FlatContext;
  private revision = -1;
  private appliedContextRevision: number | undefined;

  /**
   * Apply a snapshot. Returns `true` when the snapshot was newer than the current one
   * and was applied, `false` when it was ignored. A snapshot without a configuration
   * keeps the current configuration and only updates the context, except:
   * - `ERROR`: an authoritative failure drops the served configuration: evaluations
   *   return the application default with an error code until a later successful fetch (D5).
   * - `NOT_READY` with a context: assignments for a changed targeting key are being
   *   fetched (M7/D25), so defaults are served until the new snapshot arrives.
   */
  apply(snapshot: FlagsSnapshot): boolean {
    if (snapshot.revision <= this.revision) {
      return false;
    }
    this.revision = snapshot.revision;
    if (snapshot.configuration === undefined) {
      const dropConfiguration =
        snapshot.status === 'ERROR' || (snapshot.status === 'NOT_READY' && snapshot.context !== undefined);
      if (dropConfiguration) {
        this.provider = undefined;
        this.precomputed = undefined;
        this.context = undefined;
        if (snapshot.context !== undefined) {
          this.appliedContextRevision = snapshot.contextRevision;
        }
      }
      if (!dropConfiguration && snapshot.context !== undefined) {
        this.setContext(snapshot.context);
        this.appliedContextRevision = snapshot.contextRevision;
      }
      return true;
    }
    const decoded = configurationFromString(snapshot.configuration);
    if (decoded.precomputed !== undefined || decoded.precomputedError !== undefined) {
      this.provider = undefined;
      this.precomputed = decoded;
    } else if (decoded.rules !== undefined) {
      this.precomputed = undefined;
      const provider = this.provider ?? new DatadogCoreProvider();
      this.provider = provider;
      provider.setConfiguration(decoded);
    } else {
      // An undecodable configuration is never published by main (the fetchers validate
      // the wire round trip); keep the previously applied one.
      return true;
    }
    if (snapshot.context !== undefined) {
      this.setContext(snapshot.context);
      this.appliedContextRevision = snapshot.contextRevision;
    }
    return true;
  }

  private setContext(context: FlatContext) {
    if (this.precomputed !== undefined) {
      // Precomputed assignments are evaluated against the snapshot context directly —
      // the context they were computed for (D24); the provider context path does not apply.
      this.context = context;
      return;
    }
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
    if (this.precomputed !== undefined) {
      const result = evaluatePrecomputedConfiguration(
        this.precomputed,
        type,
        flagKey,
        defaultValue as never,
        this.context ?? {}
      );
      return { flagKey, flagMetadata: {}, ...result } as EvaluationDetails<T>;
    }
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

  /** Release the evaluators. Subsequent resolves return the default with `PROVIDER_NOT_READY`. */
  stop(): void {
    this.provider = undefined;
    this.precomputed = undefined;
    this.context = undefined;
    this.revision = -1;
    this.appliedContextRevision = undefined;
  }
}
