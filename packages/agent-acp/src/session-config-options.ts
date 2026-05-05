import type * as acp from "@agentclientprotocol/sdk";
import { appendTimingTraceEvent, type RunTimingTrace } from "@nanoboss/app-support";

import type { DownstreamAgentConfig } from "./types.ts";

export async function applyConfiguredSessionOptions(
  connection: acp.ClientSideConnection,
  sessionId: acp.SessionId,
  config: DownstreamAgentConfig,
  timingTrace?: RunTimingTrace,
): Promise<void> {
  if (config.model) {
    appendTimingTraceEvent(timingTrace, "default_session", "set_session_model_started", {
      sessionId,
      model: config.model,
    });
    await connection.unstable_setSessionModel({
      sessionId,
      modelId: config.model,
    });
    appendTimingTraceEvent(timingTrace, "default_session", "set_session_model_completed", {
      sessionId,
      model: config.model,
    });
  }

  if (config.reasoningEffort) {
    appendTimingTraceEvent(timingTrace, "default_session", "set_reasoning_effort_started", {
      sessionId,
      reasoningEffort: config.reasoningEffort,
    });
    await connection.setSessionConfigOption({
      sessionId,
      configId: "reasoning_effort",
      value: config.reasoningEffort,
    });
    appendTimingTraceEvent(timingTrace, "default_session", "set_reasoning_effort_completed", {
      sessionId,
      reasoningEffort: config.reasoningEffort,
    });
  }
}
