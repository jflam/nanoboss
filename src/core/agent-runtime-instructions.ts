import type { DownstreamAgentSelection } from "./types.ts";

export function buildMcpProcedureDispatchPrompt(
  sessionId: string,
  procedureName: string,
  procedurePrompt: string,
  defaultAgentSelection?: DownstreamAgentSelection,
  dispatchCorrelationId?: string,
): string {
  return [
    "Nanoboss internal slash-command dispatch.",
    "Internal control message for the current persistent master conversation.",
    "Use the globally registered `nanoboss` MCP server.",
    "Do not inspect repo files, CLI wiring, session pointer files, or ~/.nanoboss.",
    "The client may expose the tools under bare names or namespaced handles such as `mcp__nanoboss__procedure_dispatch_start` or similar names that contain `procedure_dispatch_start` / `procedure_dispatch_wait`.",
    "Use the global nanoboss MCP handle that contains `procedure_dispatch_start` for step 1 and the matching `procedure_dispatch_wait` handle for step 2.",
    `Target session id: ${sessionId}`,
    "Step 1: call the chosen `procedure_dispatch_start` tool exactly once with this JSON:",
    JSON.stringify({
      sessionId,
      name: procedureName,
      prompt: procedurePrompt,
      defaultAgentSelection,
      dispatchCorrelationId,
    }),
    "Step 2: after start returns a dispatch id, repeatedly call the chosen `procedure_dispatch_wait` tool with that dispatch id until status is `completed` or `failed`.",
    "Use a short bounded wait on each poll.",
    "Do not answer from your own knowledge.",
    "If the final status is `completed`, reply with exactly the final tool result text and nothing else.",
    "If the final status is `failed`, reply with exactly the tool error text and nothing else.",
    "No prefatory explanation.",
  ].join("\n\n");
}
