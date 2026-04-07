import { plugin } from "bun";

const typiaPreloadStateKey = Symbol.for("nanoboss.typia-preload-state");

type TypiaPreloadState = {
  initialized: boolean;
  promise?: Promise<void>;
};

const globalWithTypiaPreloadState = globalThis as typeof globalThis & {
  [typiaPreloadStateKey]?: TypiaPreloadState;
};

const typiaPreloadState = globalWithTypiaPreloadState[typiaPreloadStateKey] ??= {
  initialized: false,
};

if (!shouldSkipTypiaPreloadForEntryPoint(process.argv[1], process.env)) {
  if (!typiaPreloadState.initialized) {
    typiaPreloadState.promise ??= initializeTypiaPlugin(typiaPreloadState);
    await typiaPreloadState.promise;
  }
}

export function shouldSkipTypiaPreloadForEntryPoint(
  script: string | undefined,
  env: Record<string, string | undefined>,
): boolean {
  if (env.NANOBOSS_SKIP_TYPIA_PRELOAD === "1") {
    return true;
  }

  const normalizedScript = (script ?? "").replaceAll("\\", "/");
  return normalizedScript === "build.ts"
    || normalizedScript.endsWith("/build.ts")
    || /(^|\/)tests\/fixtures\/[^/]*mock-agent\.ts$/.test(normalizedScript);
}

async function initializeTypiaPlugin(state: TypiaPreloadState): Promise<void> {
  try {
    const { default: UnpluginTypia } = await import("@ryoppippi/unplugin-typia/bun");
    void plugin(UnpluginTypia({ log: false }));
    state.initialized = true;
  } catch {
    // Compiled nanoboss binaries do not need the typia Bun plugin at runtime.
  } finally {
    if (!state.initialized) {
      delete state.promise;
    }
  }
}
