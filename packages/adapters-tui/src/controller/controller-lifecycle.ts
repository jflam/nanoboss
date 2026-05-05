import type { SessionStreamHandle } from "@nanoboss/adapters-http";

import { closeControllerStream } from "./controller-stream.ts";

interface ControllerExitSignal {
  exited: Promise<void>;
  resolve: () => void;
}

export function createControllerExitSignal(): ControllerExitSignal {
  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  return { exited, resolve: resolveExit };
}

export function requestControllerExit(params: {
  stopped: boolean;
  onExit?: () => void;
  resolveExit: () => void;
}): void {
  if (params.stopped) {
    return;
  }

  params.onExit?.();
  params.resolveExit();
}

export async function stopControllerLifecycle(params: {
  stopped: boolean;
  stream?: SessionStreamHandle;
  setStopped: (stopped: boolean) => void;
}): Promise<SessionStreamHandle | undefined> {
  if (params.stopped) {
    return params.stream;
  }

  params.setStopped(true);
  return await closeControllerStream(params.stream);
}
