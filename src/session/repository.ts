import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getNanobossHome, getSessionDir } from "../core/config.ts";
import { formatErrorMessage } from "../core/error-format.ts";
import { parseDownstreamAgentSelection } from "../core/downstream-agent-selection.ts";
import { resolveWorkspaceKey } from "../core/workspace-identity.ts";
import type {
  ContinuationUi,
  DownstreamAgentSelection,
  KernelValue,
  PendingContinuation,
  SessionRef,
  Simplify2CheckpointContinuationUiAction,
  Simplify2FocusPickerContinuationUi,
  Simplify2FocusPickerContinuationUiAction,
  Simplify2FocusPickerContinuationUiEntry,
} from "../core/types.ts";
import { createSessionRef } from "../core/types.ts";

const SESSION_METADATA_FILE = "session.json";
const CURRENT_SESSION_INDEX_FILE = "current-sessions.json";

export interface SessionMetadata {
  session: SessionRef;
  cwd: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  initialPrompt?: string;
  lastPrompt?: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  defaultAgentSessionId?: string;
  pendingContinuation?: PendingContinuation;
}

function getSessionMetadataPath(sessionId: string, rootDir?: string): string {
  return join(rootDir ?? getSessionDir(sessionId), SESSION_METADATA_FILE);
}

export function writeSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  mkdirSync(metadata.rootDir, { recursive: true });
  writeFileSync(
    getSessionMetadataPath(metadata.session.sessionId, metadata.rootDir),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  // `current-sessions.json` is a workspace-local cache of the canonical session snapshot.
  mkdirSync(getNanobossHome(), { recursive: true });
  writeCurrentWorkspaceIndex(metadata);
  return metadata;
}

export function readSessionMetadata(sessionId: string, rootDir?: string): SessionMetadata | undefined {
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

export function listSessionSummaries(): SessionMetadata[] {
  const sessionsDir = join(getNanobossHome(), "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSessionMetadata(entry.name, join(sessionsDir, entry.name)))
    .filter((entry): entry is SessionMetadata => entry !== undefined)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export function readCurrentSessionMetadata(cwd: string): SessionMetadata | undefined {
  const cached = readCurrentWorkspaceMetadata(cwd);
  if (!cached) {
    return undefined;
  }

  return readSessionMetadata(cached.session.sessionId, cached.rootDir) ?? readSessionMetadata(cached.session.sessionId);
}

function getCurrentSessionMetadataIndexPath(): string {
  return join(getNanobossHome(), CURRENT_SESSION_INDEX_FILE);
}

function writeCurrentWorkspaceIndex(metadata: SessionMetadata): void {
  const nextIndex = readCurrentWorkspaceIndex();
  nextIndex[resolveWorkspaceKey(metadata.cwd)] = metadata;
  writeFileSync(
    getCurrentSessionMetadataIndexPath(),
    `${JSON.stringify({ workspaces: nextIndex }, null, 2)}\n`,
    "utf8",
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
  const sessionId = asNonEmptyString(asRecord(raw.session)?.sessionId);
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
    ui: parseContinuationUi(record?.ui),
  };
}

function parseContinuationUi(value: unknown): ContinuationUi | undefined {
  const record = asRecord(value);
  if (record?.kind === "simplify2_checkpoint") {
    const title = asNonEmptyString(record.title);
    const actions = Array.isArray(record.actions)
      ? record.actions
        .map((entry) => parseSimplify2ContinuationAction(asRecord(entry)))
        .filter((entry): entry is NonNullable<ReturnType<typeof parseSimplify2ContinuationAction>> => entry !== undefined)
      : [];

    if (!title || actions.length === 0) {
      return undefined;
    }

    return {
      kind: "simplify2_checkpoint",
      title,
      actions,
    };
  }

  if (record?.kind !== "simplify2_focus_picker") {
    return undefined;
  }

  return parseSimplify2FocusPickerContinuationUi(record);
}

function parseSimplify2ContinuationAction(
  record: Record<string, unknown> | undefined,
): Simplify2CheckpointContinuationUiAction | undefined {
  const id = asNonEmptyString(record?.id);
  if (id !== "approve" && id !== "stop" && id !== "focus_tests" && id !== "other") {
    return undefined;
  }

  const label = asNonEmptyString(record?.label);
  if (!label) {
    return undefined;
  }

  return {
    id,
    label,
    reply: asNonEmptyString(record?.reply),
    description: asNonEmptyString(record?.description),
  };
}

function parseSimplify2FocusPickerContinuationUi(
  record: Record<string, unknown>,
): Simplify2FocusPickerContinuationUi | undefined {
  const title = asNonEmptyString(record.title);
  const entries = Array.isArray(record.entries)
    ? record.entries
      .map((entry) => parseSimplify2FocusPickerEntry(asRecord(entry)))
      .filter((entry): entry is Simplify2FocusPickerContinuationUiEntry => entry !== undefined)
    : [];
  const actions = Array.isArray(record.actions)
    ? record.actions
      .map((entry) => parseSimplify2FocusPickerAction(asRecord(entry)))
      .filter((entry): entry is Simplify2FocusPickerContinuationUiAction => entry !== undefined)
    : [];

  if (!title || actions.length === 0) {
    return undefined;
  }

  return {
    kind: "simplify2_focus_picker",
    title,
    entries,
    actions,
  };
}

function parseSimplify2FocusPickerEntry(
  record: Record<string, unknown> | undefined,
): Simplify2FocusPickerContinuationUiEntry | undefined {
  const id = asNonEmptyString(record?.id);
  const title = asNonEmptyString(record?.title);
  const updatedAt = asNonEmptyString(record?.updatedAt);
  const status = asNonEmptyString(record?.status);
  if (
    !id
    || !title
    || !updatedAt
    || (status !== "active" && status !== "paused" && status !== "finished" && status !== "archived")
  ) {
    return undefined;
  }

  return {
    id,
    title,
    updatedAt,
    status,
    subtitle: asNonEmptyString(record?.subtitle),
    lastSummary: asNonEmptyString(record?.lastSummary),
  };
}

function parseSimplify2FocusPickerAction(
  record: Record<string, unknown> | undefined,
): Simplify2FocusPickerContinuationUiAction | undefined {
  const id = asNonEmptyString(record?.id);
  if (id !== "continue" && id !== "archive" && id !== "new" && id !== "cancel") {
    return undefined;
  }

  const label = asNonEmptyString(record?.label);
  if (!label) {
    return undefined;
  }

  return {
    id,
    label,
  };
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
