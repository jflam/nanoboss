import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

import { resolveWorkspaceKey, writeTextFileAtomicSync } from "@nanoboss/app-support";
import type {
  JsonValue,
  KernelValue,
  PendingContinuation,
  SessionMetadata,
} from "@nanoboss/contracts";
import { createSessionRef } from "@nanoboss/contracts";
import { formatErrorMessage } from "@nanoboss/procedure-sdk";
import { parseDownstreamAgentSelection } from "./agent-selection.ts";
import { getNanobossHome, getSessionDir } from "./paths.ts";

const SESSION_METADATA_FILE = "session.json";
const CURRENT_SESSION_INDEX_FILE = "current-sessions.json";

function getSessionMetadataPath(sessionId: string, rootDir?: string): string {
  return join(rootDir ?? getSessionDir(sessionId), SESSION_METADATA_FILE);
}

export function writeStoredSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  mkdirSync(metadata.rootDir, { recursive: true });
  writeTextFileAtomicSync(
    getSessionMetadataPath(metadata.session.sessionId, metadata.rootDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  // `current-sessions.json` is a workspace-local cache of the canonical session snapshot.
  mkdirSync(getNanobossHome(), { recursive: true });
  writeCurrentWorkspaceIndex(metadata);
  return metadata;
}

export function readStoredSessionMetadata(sessionId: string, rootDir?: string): SessionMetadata | undefined {
  const path = getSessionMetadataPath(sessionId, rootDir);
  if (!existsSync(path)) {
    return undefined;
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`Failed to parse session metadata at ${path}: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }

  const metadata = parseSessionMetadata(raw);
  if (!metadata) {
    throw new Error(`Session metadata at ${path} is missing required fields`);
  }

  return metadata;
}

export function listStoredSessions(): SessionMetadata[] {
  const sessionsDir = join(getNanobossHome(), "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      try {
        return readStoredSessionMetadata(entry.name, join(sessionsDir, entry.name));
      } catch (error) {
        // A single unreadable/legacy session directory must not break the whole listing.
        console.warn(`[nanoboss] skipping session ${entry.name}: ${formatErrorMessage(error)}`);
        return undefined;
      }
    })
    .filter((entry): entry is SessionMetadata => entry !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readCurrentWorkspaceSessionMetadata(cwd: string): SessionMetadata | undefined {
  const cached = readCurrentWorkspaceMetadata(cwd);
  if (!cached) {
    return undefined;
  }

  return readStoredSessionMetadata(cached.session.sessionId, cached.rootDir)
    ?? readStoredSessionMetadata(cached.session.sessionId);
}

function getCurrentSessionMetadataIndexPath(): string {
  return join(getNanobossHome(), CURRENT_SESSION_INDEX_FILE);
}

function writeCurrentWorkspaceIndex(metadata: SessionMetadata): void {
  const nextIndex = readCurrentWorkspaceIndex();
  nextIndex[resolveWorkspaceKey(metadata.cwd)] = metadata;
  writeTextFileAtomicSync(
    getCurrentSessionMetadataIndexPath(),
    `${JSON.stringify({ workspaces: nextIndex }, null, 2)}\n`,
  );
}

function readCurrentWorkspaceMetadata(cwd: string): SessionMetadata | undefined {
  return readCurrentWorkspaceIndex()[resolveWorkspaceKey(cwd)];
}

function readCurrentWorkspaceIndex(): Record<string, SessionMetadata> {
  try {
    const raw = JSON.parse(readFileSync(getCurrentSessionMetadataIndexPath(), "utf8")) as Record<string, unknown>;
    const workspaces = asRecord(raw.workspaces);
    if (!workspaces) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(workspaces)
        .map(([key, value]) => [key, parseSessionMetadata(asRecord(value) ?? {})] as const)
        .filter((entry): entry is [string, SessionMetadata] => entry[1] !== undefined),
    );
  } catch {
    return {};
  }
}

function parseSessionMetadata(raw: Record<string, unknown>): SessionMetadata | undefined {
  // Accept both the current nested shape ({ session: { sessionId } }) and the legacy
  // flat shape ({ sessionId }) so older session directories remain listable.
  const sessionId = asNonEmptyString(asRecord(raw.session)?.sessionId)
    ?? asNonEmptyString(raw.sessionId);
  const rootDir = asNonEmptyString(raw.rootDir);
  const createdAt = asNonEmptyString(raw.createdAt);
  const updatedAt = asNonEmptyString(raw.updatedAt);
  const cwd = asNonEmptyString(raw.cwd);

  if (!sessionId || !rootDir || !cwd || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    session: createSessionRef(sessionId),
    cwd,
    rootDir,
    createdAt,
    updatedAt,
    initialPrompt: asNonEmptyString(raw.initialPrompt),
    lastPrompt: asNonEmptyString(raw.lastPrompt),
    autoApprove: raw.autoApprove === true ? true : undefined,
    defaultAgentSelection: parseDownstreamAgentSelection(raw.defaultAgentSelection),
    defaultAgentSessionId: asNonEmptyString(raw.defaultAgentSessionId),
    pendingContinuation: parsePendingContinuation(raw.pendingContinuation),
  };
}

function parsePendingContinuation(value: unknown): PendingContinuation | undefined {
  const record = asRecord(value);
  const procedure = asNonEmptyString(record?.procedure);
  const run = parseRunRef(record?.run);
  const question = asNonEmptyString(record?.question);
  if (!procedure || !run || !question || !("state" in (record ?? {}))) {
    return undefined;
  }

  const suggestedReplies = Array.isArray(record?.suggestedReplies)
    ? record.suggestedReplies.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

  return {
    procedure,
    run,
    question,
    state: record?.state as KernelValue,
    inputHint: asNonEmptyString(record?.inputHint),
    suggestedReplies: suggestedReplies && suggestedReplies.length > 0 ? suggestedReplies : undefined,
    form: parseContinuationForm(record?.form),
  };
}

function parseContinuationForm(value: unknown): { formId: string; payload: JsonValue } | undefined {
  const record = asRecord(value);
  const formId = asNonEmptyString(record?.formId);
  if (!formId || !record || !("payload" in record)) {
    return undefined;
  }
  return { formId, payload: record.payload as JsonValue };
}

function parseRunRef(value: unknown): { sessionId: string; runId: string } | undefined {
  const record = asRecord(value);
  const sessionId = asNonEmptyString(record?.sessionId);
  const runId = asNonEmptyString(record?.runId);
  return sessionId && runId ? { sessionId, runId } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
