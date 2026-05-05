import type * as acp from "@agentclientprotocol/sdk";
import { projectProcedureMetadata, toAvailableCommand } from "@nanoboss/procedure-catalog";
import type {
  PendingContinuation,
  Procedure,
  ProcedureRegistryLike,
  PromptInput,
  RunResult,
} from "@nanoboss/procedure-sdk";
import {
  normalizePromptInput,
  promptInputDisplayText,
  promptInputToPlainText,
} from "@nanoboss/procedure-sdk";

import type { RuntimeContinuation } from "./runtime-events.ts";
import type { SessionState } from "./session-runtime.ts";

export const DISMISS_CONTINUATION_COMMAND_NAME = "dismiss";

const DISMISS_CONTINUATION_COMMAND: acp.AvailableCommand = {
  name: DISMISS_CONTINUATION_COMMAND_NAME,
  description: "Clear the pending paused continuation",
};

export function buildAvailableCommands(registry: ProcedureRegistryLike): acp.AvailableCommand[] {
  const commands = projectProcedureMetadata(registry.listMetadata()).map(toAvailableCommand);
  return commands.some((command) => command.name === DISMISS_CONTINUATION_COMMAND_NAME)
    ? commands
    : [...commands, DISMISS_CONTINUATION_COMMAND];
}

function toRuntimeContinuation(
  continuation?: PendingContinuation,
): RuntimeContinuation | undefined {
  if (!continuation) {
    return undefined;
  }

  return {
    procedure: continuation.procedure,
    question: continuation.question,
    inputHint: continuation.inputHint,
    suggestedReplies: continuation.suggestedReplies,
    form: continuation.form,
  };
}

export function publishPendingContinuation(
  sessionId: string,
  session: SessionState,
): void {
  session.events.publish(sessionId, {
    type: "continuation_updated",
    continuation: toRuntimeContinuation(session.pendingContinuation),
  });
}

export function setPendingContinuation(
  sessionId: string,
  session: SessionState,
  continuation?: PendingContinuation,
): void {
  session.pendingContinuation = continuation;
  publishPendingContinuation(sessionId, session);
}

export function createDismissContinuationProcedure(session: {
  pendingContinuation?: PendingContinuation;
}): Procedure {
  return {
    name: DISMISS_CONTINUATION_COMMAND_NAME,
    description: DISMISS_CONTINUATION_COMMAND.description,
    executionMode: "harness",
    async execute() {
      const pending = session.pendingContinuation;
      session.pendingContinuation = undefined;
      return pending
        ? {
            display: `Cleared the pending continuation for /${pending.procedure}. Future plain-text replies will go to /default again.`,
            summary: `Cleared /${pending.procedure} continuation`,
          }
        : {
            display: "No pending continuation was active.",
            summary: "No continuation to clear",
          };
    },
  };
}

export function buildPendingContinuation(
  procedure: string,
  result: RunResult,
): PendingContinuation {
  if (!result.pause) {
    throw new Error("Cannot persist continuation without pause metadata.");
  }

  return {
    procedure,
    run: result.run,
    question: result.pause.question,
    state: result.pause.state,
    inputHint: result.pause.inputHint,
    suggestedReplies: result.pause.suggestedReplies,
    form: result.pause.form,
  };
}

export function resolveCommand(
  input: PromptInput,
  pendingContinuation?: PendingContinuation,
): {
  commandName: string;
  commandPrompt: string;
  commandPromptInput: PromptInput;
  continuation?: PendingContinuation;
} {
  const text = promptInputDisplayText(input).trim();
  if (!text.startsWith("/")) {
    return pendingContinuation
      ? {
          commandName: pendingContinuation.procedure,
          commandPrompt: promptInputToPlainText(input),
          commandPromptInput: input,
          continuation: pendingContinuation,
        }
      : {
          commandName: "default",
          commandPrompt: promptInputToPlainText(input),
          commandPromptInput: input,
        };
  }

  const firstPart = input.parts[0];
  if (!firstPart || firstPart.type !== "text") {
    return {
      commandName: "default",
      commandPrompt: promptInputToPlainText(input),
      commandPromptInput: input,
    };
  }

  const match = firstPart.text.match(/^\s*\/(\S+)(?:\s+)?/);
  if (!match) {
    return {
      commandName: "default",
      commandPrompt: promptInputToPlainText(input),
      commandPromptInput: input,
    };
  }

  const commandName = match[1] || "default";
  const consumed = match[0].length;
  const remainingFirstText = firstPart.text.slice(consumed);
  const commandPromptInput: PromptInput = {
    parts: normalizePromptInput({
      parts: [
        { type: "text", text: remainingFirstText },
        ...input.parts.slice(1),
      ],
    }).parts,
  };

  return {
    commandName,
    commandPrompt: promptInputToPlainText(commandPromptInput),
    commandPromptInput,
  };
}
