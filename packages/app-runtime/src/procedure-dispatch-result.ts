import type * as acp from "@agentclientprotocol/sdk";
import type { ProcedureDispatchStatusResult } from "@nanoboss/procedure-engine";
import type { RunResult } from "@nanoboss/procedure-sdk";

import { isProcedureDispatchResult, isProcedureDispatchStatusResult } from "./runtime-api.ts";

export function extractProcedureDispatchResult(updates: acp.SessionUpdate[]): RunResult | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update" || update.status !== "completed") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchResultCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function extractProcedureDispatchId(updates: acp.SessionUpdate[]): string | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchIdCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function extractProcedureDispatchStatus(updates: acp.SessionUpdate[]): ProcedureDispatchStatusResult | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    for (const candidate of collectProcedureDispatchCandidates(update)) {
      const parsed = parseProcedureDispatchStatusCandidate(candidate);
      if (parsed) {
        return parsed;
      }
    }
  }

  return undefined;
}

export function extractProcedureDispatchFailure(updates: acp.SessionUpdate[]): string | undefined {
  for (const update of [...updates].reverse()) {
    if (update.sessionUpdate !== "tool_call_update") {
      continue;
    }

    const asyncFailure = parseProcedureDispatchFailureCandidate(update.rawOutput);
    if (asyncFailure) {
      return asyncFailure;
    }

    if (update.status !== "failed") {
      continue;
    }

    const rawOutput = update.rawOutput;
    if (!rawOutput || typeof rawOutput !== "object") {
      continue;
    }

    const message = (rawOutput as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return message.trim();
    }

    const error = (rawOutput as { error?: unknown }).error;
    if (typeof error === "string" && error.trim()) {
      return error.trim();
    }
  }

  return undefined;
}

function collectProcedureDispatchCandidates(update: Extract<acp.SessionUpdate, { sessionUpdate: "tool_call_update" }>): unknown[] {
  const rawOutput = update.rawOutput;
  const candidates: unknown[] = [rawOutput];

  if (rawOutput && typeof rawOutput === "object") {
    candidates.push((rawOutput as { structuredContent?: unknown }).structuredContent);
    candidates.push((rawOutput as { content?: unknown }).content);
    candidates.push((rawOutput as { detailedContent?: unknown }).detailedContent);
    candidates.push((rawOutput as { contents?: unknown }).contents);
  }

  if ("content" in update) {
    candidates.push((update as { content?: unknown }).content);
  }

  return candidates;
}

function parseProcedureDispatchResultCandidate(value: unknown): RunResult | undefined {
  if (isProcedureDispatchResult(value)) {
    return value;
  }

  if (isProcedureDispatchStatusResult(value) && value.status === "completed" && value.result) {
    return value.result;
  }

  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      return parseProcedureDispatchResultCandidate(parsed);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchResultCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchResultCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchResultCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchResultCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseProcedureDispatchIdCandidate(value: unknown): string | undefined {
  if (!value) {
    return undefined;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchIdCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchIdCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (typeof value !== "object") {
    return undefined;
  }

  const dispatchId = (value as { dispatchId?: unknown }).dispatchId;
  if (typeof dispatchId === "string" && dispatchId.trim()) {
    return dispatchId;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchIdCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchIdCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchIdCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseProcedureDispatchStatusCandidate(value: unknown): ProcedureDispatchStatusResult | undefined {
  if (isProcedureDispatchStatusResult(value)) {
    return value;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchStatusCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchStatusCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const contentText = (value as { text?: unknown }).text;
  if (typeof contentText === "string") {
    const parsed = parseProcedureDispatchStatusCandidate(contentText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchStatusCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchStatusCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}

function parseProcedureDispatchFailureCandidate(value: unknown): string | undefined {
  if (isProcedureDispatchStatusResult(value) && (value.status === "failed" || value.status === "cancelled")) {
    return value.error?.trim() || `${value.procedure} ${value.status}`;
  }

  if (typeof value === "string") {
    try {
      return parseProcedureDispatchFailureCandidate(JSON.parse(value) as unknown);
    } catch {
      return undefined;
    }
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseProcedureDispatchFailureCandidate(item);
      if (parsed) {
        return parsed;
      }
    }
    return undefined;
  }

  if (!value || typeof value !== "object") {
    return undefined;
  }

  const nestedContent = (value as { content?: unknown }).content;
  if (nestedContent !== undefined) {
    const parsed = parseProcedureDispatchFailureCandidate(nestedContent);
    if (parsed) {
      return parsed;
    }
  }

  const nestedText = (value as { text?: unknown }).text;
  if (typeof nestedText === "string") {
    const parsed = parseProcedureDispatchFailureCandidate(nestedText);
    if (parsed) {
      return parsed;
    }
  }

  const nestedResult = (value as { result?: unknown }).result;
  if (nestedResult !== undefined) {
    const parsed = parseProcedureDispatchFailureCandidate(nestedResult);
    if (parsed) {
      return parsed;
    }
  }

  return undefined;
}
