import type { BootExtensionsResult, TuiExtensionBootLog } from "../extensions/boot-extensions.ts";

interface TuiExtensionRunBoot {
  bootResult: BootExtensionsResult | undefined;
  pendingStatuses: string[];
}

interface TuiExtensionStatusSink {
  showStatus?(text: string): void;
}

type TuiExtensionBootForRun = (
  cwd: string,
  options: { log: TuiExtensionBootLog },
) => Promise<BootExtensionsResult | undefined> | BootExtensionsResult | undefined;

export async function bootTuiExtensionsForRun(
  cwd: string,
  bootExtensions: TuiExtensionBootForRun,
): Promise<TuiExtensionRunBoot> {
  const pendingStatuses: string[] = [];
  const bufferingLog: TuiExtensionBootLog = (level, text) => {
    pendingStatuses.push(`[extension:${level}] ${text}`);
  };

  const bootResult = await bootExtensions(cwd, {
    log: bufferingLog,
  });

  return {
    bootResult,
    pendingStatuses,
  };
}

export function flushTuiExtensionStatuses(
  app: TuiExtensionStatusSink,
  boot: TuiExtensionRunBoot,
): void {
  if (!app.showStatus) {
    return;
  }

  for (const text of boot.pendingStatuses) {
    app.showStatus(text);
  }

  // When one or more extensions failed to activate, point the user at
  // `/extensions` for per-extension detail. The aggregate line itself
  // was already flushed above via the buffered log replay.
  if (boot.bootResult && boot.bootResult.failedCount > 0) {
    app.showStatus("[extensions] run /extensions for details");
  }
}
