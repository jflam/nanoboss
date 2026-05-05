import {
  TuiExtensionRegistry,
  type TuiExtensionContextFactory,
} from "@nanoboss/tui-extension-catalog";

import {
  createTuiExtensionContextFactory,
  type TuiExtensionBootLog,
  type TuiExtensionBootLogLevel,
  type TuiExtensionContextFactoryDeps,
} from "./boot-extension-context.ts";
import { activateTuiExtensionRegistry } from "./boot-extension-activation.ts";
import { prepareTuiExtensionRegistry } from "./boot-extension-registry.ts";
import { createNanobossTuiTheme, type NanobossTuiTheme } from "../theme/theme.ts";

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

  const registry = await prepareTuiExtensionRegistry({
    cwd,
    log,
    profileExtensionRoot: options.profileExtensionRoot,
    extensionRoots: options.extensionRoots,
    registry: options.registry,
    skipDisk: options.skipDisk,
    skipBuiltins: options.skipBuiltins,
  });

  const activation = await activateTuiExtensionRegistry({
    registry,
    theme,
    log,
    contextFactory: options.contextFactory,
    contextFactoryDeps: options.contextFactoryDeps,
  });

  return { registry, ...activation };
}

function defaultBootLog(level: TuiExtensionBootLogLevel, text: string): void {
  process.stderr.write(`[extension:${level}] ${text}\n`);
}
