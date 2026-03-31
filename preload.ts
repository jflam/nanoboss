import { plugin } from "bun";

try {
  const { default: UnpluginTypia } = await import("@ryoppippi/unplugin-typia/bun");
  void plugin(UnpluginTypia());
} catch {
  // Compiled nanoboss binaries do not need the typia Bun plugin at runtime.
}
