import { NanobossTuiApp, type NanobossTuiAppParams } from "../app/app.ts";
import { bootExtensions, type BootExtensionsResult, type TuiExtensionBootLog } from "../extensions/boot-extensions.ts";
import {
  bootTuiExtensionsForRun,
  flushTuiExtensionStatuses,
} from "./run-extensions.ts";

export interface TuiAppRunner {
  run(): Promise<string | undefined>;
  requestExit?(): void;
  requestSigintExit?(): boolean;
  showStatus?(text: string): void;
}

export interface RunTuiAppDeps {
  createApp?: (params: NanobossTuiAppParams) => TuiAppRunner;
  /**
   * Override for the TUI-extension boot step. Tests pass a no-op here to
   * avoid touching real disk roots / builtin extensions.
   */
  bootExtensions?: (
    cwd: string,
    options: { log: TuiExtensionBootLog },
  ) => Promise<BootExtensionsResult | undefined> | BootExtensionsResult | undefined;
}

export async function createTuiAppForRun(
  params: NanobossTuiAppParams,
  deps: RunTuiAppDeps,
): Promise<TuiAppRunner> {
  // Boot TUI extensions BEFORE constructing NanobossTuiApp so every
  // registry mutation happens before NanobossAppView is built. Messages
  // emitted by extension activation are buffered here and flushed through
  // the app's status-line pathway once the controller exists.
  const cwd = params.cwd ?? process.cwd();
  const extensionBoot = await bootTuiExtensionsForRun(cwd, deps.bootExtensions ?? bootExtensions);

  const app = (deps.createApp ?? ((appParams) => new NanobossTuiApp(appParams)))({
    ...params,
    listExtensionEntries: extensionBoot.bootResult
      ? () => extensionBoot.bootResult!.registry.listMetadata()
      : undefined,
  });

  flushTuiExtensionStatuses(app, extensionBoot);

  return app;
}
