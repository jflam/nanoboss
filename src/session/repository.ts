import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getNanobossHome, getSessionDir } from "../core/config.ts";
import { resolveWorkspaceKey } from "../core/workspace-identity.ts";
import type {
  DownstreamAgentProvider,
  DownstreamAgentSelection,
  PendingProcedureContinuation,
} from "../core/types.ts";

const SESSION_METADATA_FILE = "session.json";
const CURRENT_SESSION_FILE = "current-session.json";
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

export interface SessionSummary extends SessionMetadata {
  hasNativeResume: boolean;
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
  return metadata;
}

export function readSessionMetadata(sessionId: string, rootDir?: string): SessionMetadata | undefined {
  try {
    const raw = JSON.parse(readFileSync(getSessionMetadataPath(sessionId, rootDir), "utf8")) as Record<string, unknown>;
    return parseSessionMetadata(raw, {
      fallbackSessionId: sessionId,
      fallbackRootDir: rootDir,
    });
  } catch {
    return undefined;
  }
}

export function listSessionSummaries(): SessionSummary[] {
  const sessionsDir = join(getNanobossHome(), "sessions");
  if (!existsSync(sessionsDir)) {
    return [];
  }

  return readdirSync(sessionsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => readSessionMetadata(entry.name, join(sessionsDir, entry.name)))
    .filter((entry): entry is SessionMetadata => entry !== undefined)
    .map((entry) => toSessionSummary(entry))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

function getCurrentSessionMetadataPath(): string {
  return join(getNanobossHome(), CURRENT_SESSION_FILE);
}

export function writeCurrentSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  mkdirSync(getNanobossHome(), { recursive: true });
  writeFileSync(
    getCurrentSessionMetadataPath(),
    `${JSON.stringify(metadata, null, 2)}\n`,
    "utf8",
  );
  writeCurrentWorkspaceIndex(metadata);
  return metadata;
}

export function readCurrentSessionMetadata(cwd?: string): SessionMetadata | undefined {
  if (cwd) {
    const indexed = readCurrentWorkspaceMetadata(cwd);
    if (indexed) {
      return indexed;
    }
  }

  try {
    const raw = JSON.parse(readFileSync(getCurrentSessionMetadataPath(), "utf8")) as Record<string, unknown>;
    const metadata = parseSessionMetadata(raw, {
      allowMissingCreatedAt: true,
    });
    if (!metadata || !cwd) {
      return metadata;
    }

    return resolveWorkspaceKey(metadata.cwd) === resolveWorkspaceKey(cwd)
      ? metadata
      : undefined;
  } catch {
    return undefined;
  }
}

function toSessionSummary(metadata: SessionMetadata): SessionSummary {
  return {
    ...metadata,
    hasNativeResume: Boolean(metadata.defaultAcpSessionId),
  };
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
        .map(([key, value]) => [key, parseSessionMetadata(asRecord(value) ?? {}, { allowMissingCreatedAt: true })] as const)
        .filter((entry): entry is [string, SessionMetadata] => entry[1] !== undefined),
    );
  } catch {
    return {};
  }
}

function parseSessionMetadata(
  raw: Record<string, unknown>,
  options: {
    fallbackSessionId?: string;
    fallbackRootDir?: string;
    allowMissingCreatedAt?: boolean;
  } = {},
): SessionMetadata | undefined {
  const sessionId = asNonEmptyString(raw.sessionId) ?? options.fallbackSessionId;
  const resolvedRootDir = asNonEmptyString(raw.rootDir)
    ?? options.fallbackRootDir
    ?? (sessionId ? getSessionDir(sessionId) : undefined);
  const createdAt = asNonEmptyString(raw.createdAt);
  const updatedAt = asNonEmptyString(raw.updatedAt);
  const cwd = asNonEmptyString(raw.cwd);

  if (
    !sessionId ||
    !resolvedRootDir ||
    !cwd ||
    !updatedAt ||
    (!createdAt && !options.allowMissingCreatedAt)
  ) {
    return undefined;
  }

  return {
    sessionId,
    cwd,
    rootDir: resolvedRootDir,
    createdAt: createdAt ?? updatedAt,
    updatedAt,
    initialPrompt: asNonEmptyString(raw.initialPrompt),
    lastPrompt: asNonEmptyString(raw.lastPrompt),
    defaultAgentSelection: parseDownstreamAgentSelection(raw.defaultAgentSelection),
    defaultAcpSessionId: asNonEmptyString(raw.defaultAcpSessionId),
    pendingProcedureContinuation: parsePendingProcedureContinuation(raw.pendingProcedureContinuation),
  };
}

function parseDownstreamAgentSelection(value: unknown): DownstreamAgentSelection | undefined {
  const record = asRecord(value);
  const provider = asProvider(record?.provider);
  if (!provider) {
    return undefined;
  }

  const model = asNonEmptyString(record?.model);
  return model
    ? { provider, model }
    : { provider };
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
    state: record.state,
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

function asProvider(value: unknown): DownstreamAgentProvider | undefined {
  return value === "claude" || value === "gemini" || value === "codex" || value === "copilot"
    ? value
    : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
}

function asNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}
