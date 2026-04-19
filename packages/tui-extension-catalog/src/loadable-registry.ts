import type {
  TuiExtension,
  TuiExtensionMetadata,
  TuiExtensionScope,
} from "@nanoboss/tui-extension-sdk";

/**
 * Minimal registry surface that disk loading and builtins consume. Kept
 * separate from `TuiExtensionRegistry` itself so `builtins.ts` and other
 * loaders do not need to reach into the registry's private shape.
 */
export interface LoadableTuiExtensionRegistry {
  registerBuiltinExtension(extension: TuiExtension): void;
}

/**
 * Record tracked by the registry for each discovered extension.
 */
export interface RegisteredTuiExtension {
  metadata: TuiExtensionMetadata;
  scope: TuiExtensionScope;
  /** Absolute path of the entry file on disk; undefined for builtins. */
  entryPath?: string;
  /** Load the module's default export lazily when activation runs. */
  load: () => Promise<TuiExtension>;
}

/**
 * Activation status reported by `listMetadata()` after `activateAll()` runs.
 * `pending` means `activateAll()` has not been called yet (or the extension
 * has not been reached). `active` means activate completed without throwing.
 * `failed` means activate threw; the registry has isolated the failure and
 * the error is recorded for diagnostics.
 */
export type TuiExtensionActivationStatus = "pending" | "active" | "failed";

export interface TuiExtensionStatus {
  metadata: TuiExtensionMetadata;
  scope: TuiExtensionScope;
  status: TuiExtensionActivationStatus;
  error?: Error;
}

export function assertTuiExtension(value: unknown): asserts value is TuiExtension {
  if (
    !value
    || typeof value !== "object"
    || typeof (value as TuiExtension).activate !== "function"
    || !(value as TuiExtension).metadata
    || typeof (value as TuiExtension).metadata !== "object"
    || typeof (value as TuiExtension).metadata.name !== "string"
  ) {
    throw new Error("TUI extension module does not export a valid default TuiExtension");
  }
}
