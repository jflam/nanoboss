import { TuiExtensionRegistry } from "@nanoboss/tui-extension-catalog";

import type { TuiExtensionBootLog } from "./boot-extension-context.ts";
import { registerBuiltinTuiExtensions } from "./builtin-extensions.ts";

interface PrepareTuiExtensionRegistryParams {
  cwd: string;
  log: TuiExtensionBootLog;
  profileExtensionRoot?: string;
  extensionRoots?: string[];
  registry?: TuiExtensionRegistry;
  skipDisk?: boolean;
  skipBuiltins?: boolean;
}

export async function prepareTuiExtensionRegistry({
  cwd,
  log,
  profileExtensionRoot,
  extensionRoots,
  registry: providedRegistry,
  skipDisk,
  skipBuiltins,
}: PrepareTuiExtensionRegistryParams): Promise<TuiExtensionRegistry> {
  if (providedRegistry) {
    return providedRegistry;
  }

  const registry = new TuiExtensionRegistry({
    cwd,
    profileExtensionRoot,
    extensionRoots,
  });

  if (!skipBuiltins) {
    try {
      registerBuiltinTuiExtensions(registry);
    } catch (error) {
      log("error", `failed to load builtin extensions: ${formatError(error)}`);
    }
  }

  if (!skipDisk) {
    try {
      await registry.loadFromDisk();
    } catch (error) {
      log("error", `failed to load extensions from disk: ${formatError(error)}`);
    }
  }

  return registry;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
