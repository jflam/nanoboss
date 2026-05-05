import {
  getBuildCommit,
  getBuildLabel,
  getWorkspaceIdentity,
  type WorkspaceIdentity,
} from "@nanoboss/app-support";
import { getServerHealth, type ServerHealthResponse } from "./client.ts";

export async function ensureMatchingHttpServer(
  baseUrl: string,
  options: {
    cwd?: string;
    onStatus?: (text: string) => void;
  } = {},
): Promise<void> {
  const desiredCommit = getBuildCommit();
  const desiredLabel = getBuildLabel();
  const initialHealth = await tryGetServerHealth(baseUrl);
  if (!initialHealth) {
    throw new Error(`Failed to reach the nanoboss HTTP server at ${baseUrl}`);
  }

  if (!matchesServerBuild(initialHealth, desiredCommit)) {
    throw new Error(
      `nanoboss HTTP server at ${baseUrl} is ${initialHealth.buildLabel ?? "unknown"}, but this CLI is ${desiredLabel}. Restart the server manually.`,
    );
  }

  if (options.cwd) {
    const mismatch = describeWorkspaceMismatch(initialHealth, getWorkspaceIdentity(options.cwd));
    if (mismatch) {
      throw new Error(
        `nanoboss HTTP server at ${baseUrl} is not compatible with ${options.cwd}: ${mismatch}. Start a server from this workspace or omit --server-url to use a private local server.`,
      );
    }
  }
}

async function tryGetServerHealth(baseUrl: string): Promise<ServerHealthResponse | null> {
  try {
    return await getServerHealth(baseUrl);
  } catch {
    return null;
  }
}

function matchesServerBuild(
  health: ServerHealthResponse | null,
  desiredCommit: string,
): boolean {
  return health?.buildCommit === desiredCommit;
}

function describeWorkspaceMismatch(
  health: ServerHealthResponse,
  expected: WorkspaceIdentity,
): string | undefined {
  if (health.workspaceKey && health.workspaceKey !== expected.workspaceKey) {
    return `server workspace is ${health.workspaceKey}, but this workspace is ${expected.workspaceKey}`;
  }

  if (health.repoRoot && expected.repoRoot && health.repoRoot !== expected.repoRoot) {
    return `server repo root is ${health.repoRoot}, but this workspace is ${expected.repoRoot}`;
  }

  if (health.cwd && !health.workspaceKey && health.cwd !== expected.cwd) {
    return `server cwd is ${health.cwd}, but this workspace is ${expected.cwd}`;
  }

  if (health.proceduresFingerprint && health.proceduresFingerprint !== expected.proceduresFingerprint) {
    return `server procedure fingerprint ${health.proceduresFingerprint} does not match this workspace (${expected.proceduresFingerprint})`;
  }

  return undefined;
}
