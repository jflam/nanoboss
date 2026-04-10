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
  DownstreamAgentSelection,
  KernelValue,
  PendingProcedureContinuation,
} from "../core/types.ts";

const SESSION_METADATA_FILE = "session.json";
const CURRENT_SESSION_INDEX_FILE = "current-sessions.json";

export interface SessionMetadata {
  sessionId: string;
  cwd: string;
  rootDir: string;
  createdAt: string;
  updatedAt: string;
  initialPrompt?: string;
  lastPrompt?: string;
  defaultAgentSelection?: DownstreamAgentSelection;
  defaultAcpSessionId?: string;
  pendingProcedureContinuation?: PendingProcedureContinuation;
}

function getSessionMetadataPath(sessionId: string, rootDir?: string): string {
  return join(rootDir ?? getSessionDir(sessionId), SESSION_METADATA_FILE);
}

export function writeSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  mkdirSync(metadata.rootDir, { recursive: true });
  writeFileSync(
    getSessionMetadataPath(metadata.sessionId, metadata.rootDir),
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

export function writeCurrentSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  mkdirSync(getNanobossHome(), { recursive: true });
  writeCurrentWorkspaceIndex(metadata);
  return metadata;
}

export function readCurrentSessionMetadata(cwd: string): SessionMetadata | undefined {
  return readCurrentWorkspaceMetadata(cwd);
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
  const sessionId = asNonEmptyString(raw.sessionId);
  const rootDir = asNonEmptyString(raw.rootDir);
  const createdAt = asNonEmptyString(raw.createdAt);
  const updatedAt = asNonEmptyString(raw.updatedAt);
  const cwd = asNonEmptyString(raw.cwd);

  if (!sessionId || !rootDir || !cwd || !createdAt || !updatedAt) {
    return undefined;
  }

  return {
    sessionId,
    cwd,
    rootDir,
    createdAt,
    updatedAt,
    initialPrompt: asNonEmptyString(raw.initialPrompt),
    lastPrompt: asNonEmptyString(raw.lastPrompt),
    defaultAgentSelection: parseDownstreamAgentSelection(raw.defaultAgentSelection),
    defaultAcpSessionId: asNonEmptyString(raw.defaultAcpSessionId),
    pendingProcedureContinuation: parsePendingProcedureContinuation(raw.pendingProcedureContinuation),
  };
}

function parsePendingProcedureContinuation(value: unknown): PendingProcedureContinuation | undefined {
  const record = asRecord(value);
  const procedure = asNonEmptyString(record?.procedure);
  const cell = parseCellRef(record?.cell);
  const question = asNonEmptyString(record?.question);
  if (!procedure || !cell || !question || !("state" in (record ?? {}))) {
    return undefined;
  }

  const suggestedReplies = Array.isArray(record?.suggestedReplies)
    ? record.suggestedReplies.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : undefined;

  return {
    procedure,
    cell,
    question,
    state: record?.state as KernelValue,
    inputHint: asNonEmptyString(record?.inputHint),
    suggestedReplies: suggestedReplies && suggestedReplies.length > 0 ? suggestedReplies : undefined,
  };
}

function parseCellRef(value: unknown): PendingProcedureContinuation["cell"] | undefined {
  const record = asRecord(value);
  const sessionId = asNonEmptyString(record?.sessionId);
  const cellId = asNonEmptyString(record?.cellId);
  return sessionId && cellId ? { sessionId, cellId } : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
