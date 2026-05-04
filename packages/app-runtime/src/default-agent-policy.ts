import type { PreparedDefaultPrompt } from "@nanoboss/procedure-engine";
import {
  appendTimingTraceEvent,
  type RunTimingTrace,
} from "@nanoboss/app-support";
import {
  promptInputDisplayText,
  type PromptInput,
} from "@nanoboss/procedure-sdk";

import {
  prependPromptInputText,
} from "./runtime-prompt.ts";
import {
  collectUnsyncedProcedureMemoryCards,
  renderProcedureMemoryCardsSection,
} from "./memory-cards.ts";
import type { SessionState } from "./session-runtime.ts";

const SESSION_TOOL_GUIDANCE = [
  "Nanoboss session tool guidance:",
  "- For prior stored procedure results, prefer the global `nanoboss` MCP tools over filesystem inspection.",
  "- Use list_runs(...) to find prior chat-visible commands such as /default, /linter, or /second-opinion.",
  "- Use get_run_descendants(...) to inspect nested procedure and agent calls under one run; set maxDepth=1 when you only want direct children.",
  "- Use get_run_ancestors(...) to identify which top-level run owns a nested run; set limit=1 when you only want the direct parent.",
  "- After you find a candidate run, use get_run(...) for exact metadata and read_ref(...) for exact stored values.",
  "- If read_ref(...) returns nested refs such as critique or answer, call read_ref(...) on those refs too.",
  "- Use list_runs({ scope: \"recent\" }) only for true global recency scans across the whole session; it is not the primary retrieval path.",
  "- Do not treat not-found results from a bounded scan as proof of absence unless the search scope was exhaustive.",
  "- Never inspect ~/.nanoboss/agent-logs directly; active transcript files can recurse into the current run.",
  "- If filesystem fallback is unavoidable, scope it to a specific session path such as ~/.nanoboss/sessions/<sessionId> or current-sessions.json; never scan ~/.nanoboss broadly.",
  "- Do not inspect ~/.nanoboss/sessions directly unless the nanoboss MCP tools fail.",
].join("\n");

function renderSessionToolGuidance(): string {
  return SESSION_TOOL_GUIDANCE;
}

export function shouldPrewarmDefaultAgentSession(): boolean {
  return process.env.NANOBOSS_PREWARM_DEFAULT_SESSION !== "0";
}

export function prepareDefaultPrompt(
  session: SessionState,
  promptInput: PromptInput,
  runId: string,
  timingTrace?: RunTimingTrace,
): PreparedDefaultPrompt {
  const prompt = promptInputDisplayText(promptInput);
  appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_started", {
    runId,
    promptLength: prompt.length,
  });
  const cards = collectUnsyncedProcedureMemoryCards(
    session.store,
    session.syncedProcedureMemoryRunIds,
  );
  const blocks: string[] = [];
  const memoryUpdate = renderProcedureMemoryCardsSection(cards);
  const includeRecoveryGuidance = shouldIncludeRecoveredProcedureGuidance(session);

  if (cards.length > 0) {
    session.events.publish(session.store.sessionId, {
      type: "memory_cards",
      runId,
      cards,
    });
  }

  if (memoryUpdate) {
    blocks.push(memoryUpdate);
  }

  if (memoryUpdate || includeRecoveryGuidance) {
    blocks.push(renderSessionToolGuidance());
  }

  if (blocks.length === 0) {
    appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_completed", {
      runId,
      cardCount: cards.length,
      includedRecoveryGuidance: includeRecoveryGuidance,
      wrappedPrompt: false,
      promptLength: prompt.length,
    });
    return {
      promptInput,
      markSubmitted() {},
    };
  }

  const preparedPrompt = prependPromptInputText(promptInput, [
    ...blocks,
    "User message:",
  ]);
  appendTimingTraceEvent(timingTrace, "service", "prepare_default_prompt_completed", {
    runId,
    cardCount: cards.length,
    includedRecoveryGuidance: includeRecoveryGuidance,
    wrappedPrompt: true,
    promptLength: promptInputDisplayText(preparedPrompt).length,
  });

  return {
    promptInput: preparedPrompt,
    markSubmitted: () => {
      for (const card of cards) {
        session.syncedProcedureMemoryRunIds.add(card.run.runId);
      }
    },
  };
}

function shouldIncludeRecoveredProcedureGuidance(session: SessionState): boolean {
  if (!session.recentRecoverySyncAtMs) {
    return false;
  }

  return Date.now() - session.recentRecoverySyncAtMs <= getRecoveredProcedureGuidanceWindowMs();
}

function getRecoveredProcedureGuidanceWindowMs(): number {
  const value = Number(process.env.NANOBOSS_RECOVERED_PROCEDURE_GUIDANCE_WINDOW_MS ?? "300000");
  return Number.isFinite(value) && value > 0 ? value : 300000;
}
