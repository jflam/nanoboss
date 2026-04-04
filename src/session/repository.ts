import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getNanobossHome, getSessionDir } from "../core/config.ts";
import type { DownstreamAgentProvider, DownstreamAgentSelection } from "../core/types.ts";
import { SessionStore } from "./store.ts";

const SESSION_METADATA_FILE = "session.json";
const CURRENT_SESSION_FILE = "current-session.json";

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
}

export interface SessionSummary extends SessionMetadata {
  hasNativeResume: boolean;
}

export class SessionRepository {
  openStore(params: { sessionId: string; cwd: string; rootDir?: string }): SessionStore {
    return new SessionStore(params);
  }

  getMetadataPath(sessionId: string, rootDir?: string): string {
    return join(rootDir ?? getSessionDir(sessionId), SESSION_METADATA_FILE);
  }

  writeMetadata(metadata: SessionMetadata): SessionMetadata {
    mkdirSync(metadata.rootDir, { recursive: true });
    writeFileSync(
      this.getMetadataPath(metadata.sessionId, metadata.rootDir),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    return metadata;
  }

  readMetadata(sessionId: string, rootDir?: string): SessionMetadata | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.getMetadataPath(sessionId, rootDir), "utf8")) as Record<string, unknown>;
      return parseSessionMetadata(raw, {
        fallbackSessionId: sessionId,
        fallbackRootDir: rootDir,
      });
    } catch {
      return undefined;
    }
  }

  listSummaries(): SessionSummary[] {
    const sessionsDir = join(getNanobossHome(), "sessions");
    if (!existsSync(sessionsDir)) {
      return [];
    }

    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => this.readMetadata(entry.name, join(sessionsDir, entry.name)))
      .filter((entry): entry is SessionMetadata => entry !== undefined)
      .map((entry) => this.toSummary(entry))
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  findSummary(sessionId: string): SessionSummary | undefined {
    const metadata = this.readMetadata(sessionId);
    return metadata ? this.toSummary(metadata) : undefined;
  }

  resolveMostRecentSummary(cwd: string): SessionSummary | undefined {
    const summaries = this.listSummaries();
    return summaries.find((session) => session.cwd === cwd) ?? summaries[0];
  }

  getCurrentMetadataPath(): string {
    return join(getNanobossHome(), CURRENT_SESSION_FILE);
  }

  writeCurrentMetadata(metadata: SessionMetadata): SessionMetadata {
    mkdirSync(getNanobossHome(), { recursive: true });
    writeFileSync(
      this.getCurrentMetadataPath(),
      `${JSON.stringify(metadata, null, 2)}\n`,
      "utf8",
    );
    return metadata;
  }

  readCurrentMetadata(): SessionMetadata | undefined {
    try {
      const raw = JSON.parse(readFileSync(this.getCurrentMetadataPath(), "utf8")) as Record<string, unknown>;
      return parseSessionMetadata(raw, {
        allowMissingCreatedAt: true,
      });
    } catch {
      return undefined;
    }
  }

  readCurrentSummary(): SessionSummary | undefined {
    const metadata = this.readCurrentMetadata();
    return metadata ? this.toSummary(metadata) : undefined;
  }

  toSummary(metadata: SessionMetadata): SessionSummary {
    return {
      ...metadata,
      hasNativeResume: Boolean(metadata.defaultAcpSessionId),
    };
  }
}

export const sessionRepository = new SessionRepository();

export function getSessionMetadataPath(sessionId: string, rootDir?: string): string {
  return sessionRepository.getMetadataPath(sessionId, rootDir);
}

export function writeSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  return sessionRepository.writeMetadata(metadata);
}

export function readSessionMetadata(sessionId: string, rootDir?: string): SessionMetadata | undefined {
  return sessionRepository.readMetadata(sessionId, rootDir);
}

export function listSessionSummaries(): SessionSummary[] {
  return sessionRepository.listSummaries();
}

export function findSessionSummary(sessionId: string): SessionSummary | undefined {
  return sessionRepository.findSummary(sessionId);
}

export function resolveMostRecentSessionSummary(cwd: string): SessionSummary | undefined {
  return sessionRepository.resolveMostRecentSummary(cwd);
}

export function getCurrentSessionMetadataPath(): string {
  return sessionRepository.getCurrentMetadataPath();
}

export function writeCurrentSessionMetadata(metadata: SessionMetadata): SessionMetadata {
  return sessionRepository.writeCurrentMetadata(metadata);
}

export function readCurrentSessionMetadata(): SessionMetadata | undefined {
  return sessionRepository.readCurrentMetadata();
}

export function toSessionSummary(metadata: SessionMetadata): SessionSummary {
  return sessionRepository.toSummary(metadata);
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
