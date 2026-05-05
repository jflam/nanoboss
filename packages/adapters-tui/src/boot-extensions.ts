import {
  TuiExtensionRegistry,
  type TuiExtensionContextFactory,
  type TuiExtensionContributionCounts,
} from "@nanoboss/tui-extension-catalog";

import {
  createTuiExtensionContextFactory,
  type TuiExtensionBootLog,
  type TuiExtensionBootLogLevel,
  type TuiExtensionContextFactoryDeps,
} from "./boot-extension-context.ts";
import { registerBuiltinTuiExtensions } from "./builtin-extensions.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "./theme.ts";

export {
  createTuiExtensionContextFactory,
  type TuiExtensionBootLog,
  type TuiExtensionBootLogLevel,
  type TuiExtensionContextFactoryDeps,
} from "./boot-extension-context.ts";

export interface BootExtensionsOptions {
  /** Theme exposed on `ctx.theme`; defaults to a fresh nanoboss theme. */
  theme?: NanobossTuiTheme;
  /** Override of the profile extension root (useful for tests). */
  profileExtensionRoot?: string;
  /** Explicit disk roots (useful for tests / hermetic runs). */
  extensionRoots?: string[];
  /** Log router; defaults to stderr so failures are at least visible. */
  log?: TuiExtensionBootLog;
  /**
   * Pre-built registry. When supplied, `bootExtensions` will NOT call
   * `loadFromDisk()` again — the caller is responsible for seeding it.
   * Exposed primarily for tests that register builtin extensions directly.
   */
  registry?: TuiExtensionRegistry;
  /** Skip calling `loadFromDisk()`. Useful for hermetic tests. */
  skipDisk?: boolean;
  /** Skip seeding adapter-owned builtins. Useful for hermetic tests. */
  skipBuiltins?: boolean;
  /** Override for the per-extension context factory (tests only). */
  contextFactory?: TuiExtensionContextFactory;
  /** Dependency overrides forwarded to the default context factory. */
  contextFactoryDeps?: TuiExtensionContextFactoryDeps;
}

export interface BootExtensionsResult {
  registry: TuiExtensionRegistry;
  failedCount: number;
  /** One-line aggregate status, set only when `failedCount > 0`. */
  aggregateStatus?: string;
}

/**
 * Discover, load, and activate TUI extensions across builtin/profile/repo
 * tiers. Returns after every extension's `activate` has either completed or
 * been isolated as failed; no single extension can prevent startup.
 *
 * Must be awaited BEFORE the first render (i.e. before `NanobossAppView`
 * is constructed) so every contribution is visible on first paint.
 */
export async function bootExtensions(
  cwd: string,
  options: BootExtensionsOptions = {},
): Promise<BootExtensionsResult> {
  const theme = options.theme ?? createNanobossTuiTheme();
  const log = options.log ?? defaultBootLog;
  const registry = options.registry
    ?? new TuiExtensionRegistry({
      cwd,
      profileExtensionRoot: options.profileExtensionRoot,
      extensionRoots: options.extensionRoots,
    });

  if (!options.registry && !options.skipBuiltins) {
    try {
      registerBuiltinTuiExtensions(registry);
    } catch (error) {
      log("error", `failed to load builtin extensions: ${formatError(error)}`);
    }
  }

  if (!options.registry && !options.skipDisk) {
    try {
      await registry.loadFromDisk();
    } catch (error) {
      log("error", `failed to load extensions from disk: ${formatError(error)}`);
    }
  }

  const contributionCounts = new Map<string, TuiExtensionContributionCounts>();

  const factory = options.contextFactory
    ?? createTuiExtensionContextFactory(theme, log, options.contextFactoryDeps, contributionCounts);

  await registry.activateAll(factory);

  // Forward captured contribution counts into the registry so the
  // `/extensions` slash command (and anyone else calling listMetadata)
  // sees what each extension registered during activate().
  if (!options.contextFactory) {
    for (const [name, counts] of contributionCounts) {
      registry.setContributions(name, counts);
    }
  }

  const statuses = registry.listMetadata();
  const failedCount = statuses.filter((entry) => entry.status === "failed").length;
  const result: BootExtensionsResult = { registry, failedCount };

  if (failedCount > 0) {
    const plural = failedCount === 1 ? "" : "s";
    const aggregate = `[extensions] ${failedCount} extension${plural} failed to activate`;
    result.aggregateStatus = aggregate;
    log("error", aggregate);
  }

  return result;
}

function defaultBootLog(level: TuiExtensionBootLogLevel, text: string): void {
  process.stderr.write(`[extension:${level}] ${text}\n`);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
