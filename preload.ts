import { plugin } from "bun";

const script = process.argv[1] ?? "";
const shouldSkipTypiaPreload = script.endsWith("build.ts");
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

if (!shouldSkipTypiaPreload) {
  if (!typiaPreloadState.initialized) {
    typiaPreloadState.promise ??= initializeTypiaPlugin(typiaPreloadState);
    await typiaPreloadState.promise;
  }
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
