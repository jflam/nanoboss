import type { ProcedureRegistry } from "@nanoboss/procedure-catalog";
import type { SessionUpdateEmitter } from "@nanoboss/procedure-engine";
import type { RunRef } from "@nanoboss/procedure-sdk";

import type { ActiveRunState } from "./active-run.ts";
import type { capturePersistedRuntimeEvents } from "./replay.ts";
import { refreshSessionCommands } from "./runtime-commands.ts";
import { persistSessionState, type SessionState } from "./session-runtime.ts";

export async function finishPromptRun(params: {
  sessionId: string;
  session: SessionState;
  registry: ProcedureRegistry;
  delegate?: SessionUpdateEmitter;
  emitter: { flush(): Promise<void> };
  heartbeat: { stop(): void };
  replayCapture: ReturnType<typeof capturePersistedRuntimeEvents>;
  persistedTopLevelRun?: RunRef;
  prompt: string;
  activeRun: ActiveRunState;
}): Promise<void> {
  params.heartbeat.stop();
  const availableCommands = refreshSessionCommands({
    sessionId: params.sessionId,
    session: params.session,
    registry: params.registry,
  });
  params.delegate?.emit({
    sessionUpdate: "available_commands_update",
    availableCommands,
  });
  await params.emitter.flush();
  params.replayCapture.stop();
  if (params.persistedTopLevelRun && params.replayCapture.replayEvents.length > 0) {
    params.session.store.patchRun(params.persistedTopLevelRun, {
      output: {
        replayEvents: params.replayCapture.replayEvents,
      },
    });
  }
  persistSessionState(params.session, { prompt: params.prompt });
  if (params.session.activeRun === params.activeRun) {
    params.session.activeRun = undefined;
  }
}
