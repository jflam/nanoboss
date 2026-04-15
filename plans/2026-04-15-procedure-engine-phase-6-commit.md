Subject: extract procedure-engine runtime ownership into package

Description:
- Extract the remaining procedure execution ownership into `packages/procedure-engine/src/` now that store, catalog, and agent-acp are already package-owned and app-runtime can switch to consuming a real engine boundary.
- Move engine-owned helpers for cancellation, prompt normalization, run-result shaping, timing traces, UI emission, dispatch worker spawning, and stored-kernel value conversion under the package so `packages/procedure-engine` no longer imports root `src/core/*` or `src/procedure/*` implementation.
- Shift callers to the engine public surface by exporting `CommandContextImpl`, dispatch progress helpers, UI event types, and session update emitter types from `@nanoboss/procedure-engine`, and update app-runtime plus focused tests to import those public exports instead of root shims or package-internal files.
- Keep the root `src/procedure/*` and `src/core/context*.ts` files as compatibility forwards only while staged migration continues.
- End state: primary procedure execution, child execution, dispatch recovery/progress, cancellation boundaries, and runtime context implementation all live in `packages/procedure-engine/src/`, and the remaining root files in this area are only compatibility shims.
