import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { SelfCommand } from "./self-command.ts";
import { resolveSelfCommand } from "./self-command.ts";

export const REGISTERED_MCP_SERVER_NAME = "nanoboss";
export const STDIO_PROXY_DESC = "stdio proxy";

export type McpConfigStatus =
  | { kind: "configured"; description: string }
  | { kind: "not_configured" }
  | { kind: "error"; message: string };

export type McpRegistrationResult =
  | { kind: "success" }
  | { kind: "not_installed" }
  | { kind: "failed"; message: string };

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];

export interface AgentDoctorRow {
  id: "claude" | "codex" | "gemini" | "copilot";
  name: string;
  installed: boolean;
  version?: string;
  acp: string;
  mcp: McpConfigStatus;
}

export function resolveMcpProxyCommand(): SelfCommand {
  return resolveSelfCommand("mcp", ["proxy"]);
}

export function registerMcpClaude(command = resolveMcpProxyCommand()): McpRegistrationResult {
  if (!commandExists("claude")) {
    return { kind: "not_installed" };
  }

  tryRun(["claude", "mcp", "remove", REGISTERED_MCP_SERVER_NAME]);
  for (const scope of ["local", "project", "user"]) {
    tryRun(["claude", "mcp", "remove", "-s", scope, REGISTERED_MCP_SERVER_NAME]);
  }

  const result = Bun.spawnSync({
    cmd: ["claude", "mcp", "add", "-s", "user", REGISTERED_MCP_SERVER_NAME, "--", command.command, ...command.args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return { kind: "success" };
  }

  return { kind: "failed", message: readProcessText(result) || "claude mcp add failed" };
}

export function registerMcpCodex(command = resolveMcpProxyCommand()): McpRegistrationResult {
  if (!commandExists("codex")) {
    return { kind: "not_installed" };
  }

  tryRun(["codex", "mcp", "remove", REGISTERED_MCP_SERVER_NAME]);

  const result = Bun.spawnSync({
    cmd: ["codex", "mcp", "add", REGISTERED_MCP_SERVER_NAME, "--", command.command, ...command.args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) {
    return { kind: "success" };
  }

  return { kind: "failed", message: readProcessText(result) || "codex mcp add failed" };
}

export function registerMcpGemini(command = resolveMcpProxyCommand()): McpRegistrationResult {
  if (!commandExists("gemini")) {
    return { kind: "not_installed" };
  }

  return writeJsonMcpConfig(getGeminiConfigPath(), {
    command: command.command,
    args: command.args,
    timeout: 30_000,
  });
}

export function registerMcpCopilot(command = resolveMcpProxyCommand()): McpRegistrationResult {
  if (!commandExists("copilot")) {
    return { kind: "not_installed" };
  }

  return writeJsonMcpConfig(getCopilotConfigPath(), {
    type: "stdio",
    command: command.command,
    args: command.args,
  });
}

export function getMcpConfigClaude(): McpConfigStatus {
  return readJsonMcpConfig(getClaudeConfigPath(), "url");
}

export function getMcpConfigCodex(): McpConfigStatus {
  const path = getCodexConfigPath();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = Bun.TOML.parse(raw) as Record<string, unknown>;
    const servers = asRecord(parsed.mcp_servers);
    const server = asRecord(servers[REGISTERED_MCP_SERVER_NAME]);
    return classifyServerRecord(server, "url");
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "not_configured" };
    }
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

export function getMcpConfigGemini(): McpConfigStatus {
  return readJsonMcpConfig(getGeminiConfigPath(), "httpUrl");
}

export function getMcpConfigCopilot(): McpConfigStatus {
  return readJsonMcpConfig(getCopilotConfigPath(), "url");
}

export function collectDoctorRows(): AgentDoctorRow[] {
  return [
    {
      id: "claude",
      name: "Claude Code",
      installed: commandExists("claude"),
      version: readVersion("claude", [["--version"]]),
      acp: describeBroker({
        brokerCommand: "claude-code-acp",
        packageName: "@zed-industries/claude-code-acp",
      }),
      mcp: getMcpConfigClaude(),
    },
    {
      id: "codex",
      name: "Codex",
      installed: commandExists("codex"),
      version: readVersion("codex", [["--version"]]),
      acp: describeBroker({
        brokerCommand: "codex-acp",
        packageName: "@zed-industries/codex-acp",
      }),
      mcp: getMcpConfigCodex(),
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      installed: commandExists("gemini"),
      version: readVersion("gemini", [["--version"], ["-v"]]),
      acp: "native ACP",
      mcp: getMcpConfigGemini(),
    },
    {
      id: "copilot",
      name: "Copilot CLI",
      installed: commandExists("copilot"),
      version: readVersion("copilot", [["--version"]]),
      acp: "native ACP",
      mcp: getMcpConfigCopilot(),
    },
  ];
}

export function describeMcpStatus(status: McpConfigStatus): string {
  switch (status.kind) {
    case "configured":
      return status.description === STDIO_PROXY_DESC ? "OK" : status.description;
    case "not_configured":
      return "not configured";
    case "error":
      return `error: ${status.message}`;
  }
}

function describeBroker(params: { brokerCommand: string; packageName: string }): string {
  if (!commandExists(params.brokerCommand)) {
    return "zed ACP broker missing";
  }

  const version = readNpmPackageVersion(params.packageName);
  return version ? `zed ACP broker ${version}` : "zed ACP broker";
}

function writeJsonMcpConfig(path: string, serverConfig: JsonObject): McpRegistrationResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const config = readJsonObject(path);
    const servers = asMutableRecord(config.mcpServers);
    servers[REGISTERED_MCP_SERVER_NAME] = serverConfig;
    config.mcpServers = servers;
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return { kind: "success" };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

function readJsonMcpConfig(path: string, legacyUrlField: "url" | "httpUrl"): McpConfigStatus {
  try {
    const config = readJsonObject(path);
    const servers = asRecord(config.mcpServers);
    const server = asRecord(servers[REGISTERED_MCP_SERVER_NAME]);
    return classifyServerRecord(server, legacyUrlField);
  } catch (error) {
    if (isMissingFileError(error)) {
      return { kind: "not_configured" };
    }
    return { kind: "error", message: error instanceof Error ? error.message : String(error) };
  }
}

function classifyServerRecord(
  server: Record<string, unknown> | undefined,
  legacyUrlField: "url" | "httpUrl",
): McpConfigStatus {
  if (!server) {
    return { kind: "not_configured" };
  }

  if (typeof server.command === "string") {
    const args = Array.isArray(server.args) ? server.args : [];
    const argStrings = args.filter((value): value is string => typeof value === "string");
    return endsWithMcpProxy(argStrings)
      ? { kind: "configured", description: STDIO_PROXY_DESC }
      : { kind: "configured", description: "stdio command (unexpected args)" };
  }

  if (typeof server[legacyUrlField] === "string") {
    return { kind: "configured", description: `http: ${String(server[legacyUrlField])} (legacy)` };
  }

  return { kind: "configured", description: "(configured, type unknown)" };
}

function endsWithMcpProxy(args: string[]): boolean {
  return args.length >= 2 && args[args.length - 2] === "mcp" && args[args.length - 1] === "proxy";
}

function getClaudeConfigPath(): string {
  return join(resolveHomeDir(), ".claude.json");
}

function getCodexConfigPath(): string {
  return join(resolveHomeDir(), ".codex", "config.toml");
}

function getGeminiConfigPath(): string {
  return join(resolveHomeDir(), ".gemini", "settings.json");
}

function getCopilotConfigPath(): string {
  return join(resolveHomeDir(), ".copilot", "mcp-config.json");
}

function readJsonObject(path: string): JsonObject {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return {};
    }
    throw error;
  }

  const raw = JSON.parse(text) as JsonValue;
  return isJsonObject(raw) ? raw : {};
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function asMutableRecord(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandExists(command: string): boolean {
  return Boolean(Bun.which(command, { PATH: process.env.PATH }));
}

function readVersion(command: string, candidates: string[][]): string | undefined {
  if (!commandExists(command)) {
    return undefined;
  }

  for (const args of candidates) {
  const result = Bun.spawnSync({
    cmd: [command, ...args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
    const version = parseVersion(readProcessText(result));
    if (version) {
      return version;
    }
  }

  return undefined;
}

function readNpmPackageVersion(packageName: string): string | undefined {
  const result = Bun.spawnSync({
    cmd: ["npm", "ls", "-g", packageName, "--json", "--depth=0"],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0 && readProcessText(result).trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(result.stdout)) as {
      dependencies?: Record<string, { version?: string }>;
    };
    return parsed.dependencies?.[packageName]?.version;
  } catch {
    return undefined;
  }
}

function parseVersion(text: string): string | undefined {
  const match = text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/);
  return match?.[0];
}

function tryRun(cmd: string[]): void {
  void Bun.spawnSync({
    cmd,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
}

function readProcessText(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function resolveHomeDir(): string {
  return process.env.HOME?.trim() || homedir();
}
