import { plugin } from "bun";

const script = process.argv[1] ?? "";
const shouldSkipTypiaPreload = script.endsWith("build.ts");

if (!shouldSkipTypiaPreload) {
  try {
    const { default: UnpluginTypia } = await import("@ryoppippi/unplugin-typia/bun");
    void plugin(UnpluginTypia({ log: false }));
  } catch {
    // Compiled nanoboss binaries do not need the typia Bun plugin at runtime.
  }
}
