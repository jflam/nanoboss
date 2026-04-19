import { resolve } from "node:path";

import type {
  TuiExtension,
  TuiExtensionContext,
  TuiExtensionMetadata,
  TuiExtensionScope,
} from "@nanoboss/tui-extension-sdk";

import { loadBuiltinTuiExtensions } from "./builtins.ts";
import { discoverDiskTuiExtensions, loadTuiExtensionFromPath } from "./disk-loader.ts";
import {
  assertTuiExtension,
  type LoadableTuiExtensionRegistry,
  type RegisteredTuiExtension,
  type TuiExtensionActivationStatus,
  type TuiExtensionStatus,
} from "./loadable-registry.ts";
import {
  resolveProfileExtensionRoot,
  resolveWorkspaceExtensionRoots,
} from "./paths.ts";

export interface TuiExtensionContextFactoryParams {
  metadata: TuiExtensionMetadata;
  scope: TuiExtensionScope;
  entryPath?: string;
}

/**
 * Caller-provided factory that builds a per-extension activation context.
 * The registry does not know how to wire a `TuiExtensionContext` into the
 * concrete TUI registries — the adapters-tui package owns that wiring.
 */
export type TuiExtensionContextFactory = (
  params: TuiExtensionContextFactoryParams,
) => TuiExtensionContext;

export interface TuiExtensionRegistryOptions {
  cwd?: string;
  extensionRoots?: string[];
  profileExtensionRoot?: string;
}

interface InternalEntry extends RegisteredTuiExtension {
  /** Loaded module; populated on first activation attempt. */
  loaded?: TuiExtension;
  status: TuiExtensionActivationStatus;
  error?: Error;
  /** Context handed to activate(); reused for deactivate(). */
  context?: TuiExtensionContext;
}

const SCOPE_RANK: Record<TuiExtensionScope, number> = {
  builtin: 0,
  profile: 1,
  repo: 2,
};

export class TuiExtensionRegistry implements LoadableTuiExtensionRegistry {
  private readonly entries = new Map<string, InternalEntry>();
  private readonly extensionRoots: string[];
  private readonly profileExtensionRoot: string;

  constructor(options: TuiExtensionRegistryOptions = {}) {
    const cwd = resolve(options.cwd ?? process.cwd());
    this.profileExtensionRoot = resolve(
      options.profileExtensionRoot ?? resolveProfileExtensionRoot(),
    );
    const roots = options.extensionRoots
      ?? resolveWorkspaceExtensionRoots(cwd, this.profileExtensionRoot);
    this.extensionRoots = uniquePaths(roots);
  }

  loadBuiltins(): void {
    loadBuiltinTuiExtensions(this);
  }

  registerBuiltinExtension(extension: TuiExtension): void {
    assertTuiExtension(extension);
    this.registerEntry({
      metadata: extension.metadata,
      scope: "builtin",
      load: async () => extension,
    });
  }

  async loadFromDisk(): Promise<void> {
    for (const root of this.extensionRoots) {
      const scope: TuiExtensionScope = root === this.profileExtensionRoot ? "profile" : "repo";
      const discovered = discoverDiskTuiExtensions(root)
        .slice()
        .sort((left, right) => left.metadata.name.localeCompare(right.metadata.name));

      for (const { metadata, path } of discovered) {
        this.registerEntry({
          metadata,
          scope,
          entryPath: path,
          load: () => loadTuiExtensionFromPath(path),
        });
      }
    }
  }

  listMetadata(): TuiExtensionStatus[] {
    return this.sortedEntries().map((entry) => ({
      metadata: entry.metadata,
      scope: entry.scope,
      status: entry.status,
      error: entry.error,
    }));
  }

  async activateAll(contextFactory: TuiExtensionContextFactory): Promise<void> {
    for (const entry of this.sortedEntries()) {
      if (entry.status !== "pending") {
        continue;
      }

      try {
        const extension = await this.ensureLoaded(entry);
        const context = contextFactory({
          metadata: entry.metadata,
          scope: entry.scope,
          entryPath: entry.entryPath,
        });
        entry.context = context;
        await extension.activate(context);
        entry.status = "active";
        entry.error = undefined;
      } catch (error) {
        entry.status = "failed";
        entry.error = error instanceof Error ? error : new Error(String(error));
        // Isolate the failure: log via the extension's logger if a context
        // was built before the throw, and continue with the remaining
        // extensions instead of propagating.
        if (entry.context) {
          try {
            entry.context.log.error(
              `Extension "${entry.metadata.name}" failed to activate: ${entry.error.message}`,
            );
          } catch {
            // Logging must never mask the original failure.
          }
        }
      }
    }
  }

  async deactivateAll(): Promise<void> {
    for (const entry of this.sortedEntries().reverse()) {
      if (entry.status !== "active" || !entry.loaded?.deactivate || !entry.context) {
        continue;
      }

      try {
        await entry.loaded.deactivate(entry.context);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        try {
          entry.context.log.error(
            `Extension "${entry.metadata.name}" failed to deactivate: ${err.message}`,
          );
        } catch {
          // Logging must never mask the original failure.
        }
      } finally {
        entry.status = "pending";
        entry.error = undefined;
      }
    }
  }

  private registerEntry(entry: RegisteredTuiExtension): void {
    const existing = this.entries.get(entry.metadata.name);
    if (existing && SCOPE_RANK[existing.scope] >= SCOPE_RANK[entry.scope]) {
      return;
    }

    this.entries.set(entry.metadata.name, {
      ...entry,
      status: "pending",
    });
  }

  private sortedEntries(): InternalEntry[] {
    return [...this.entries.values()].sort((left, right) =>
      left.metadata.name.localeCompare(right.metadata.name),
    );
  }

  private async ensureLoaded(entry: InternalEntry): Promise<TuiExtension> {
    if (!entry.loaded) {
      entry.loaded = await entry.load();
      assertTuiExtension(entry.loaded);
      if (entry.loaded.metadata.name !== entry.metadata.name) {
        throw new Error(
          `TUI extension module loaded as "${entry.loaded.metadata.name}" but was discovered as "${entry.metadata.name}"`,
        );
      }
    }
    return entry.loaded;
  }
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((path) => resolve(path)))];
}
