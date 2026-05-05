import type * as acp from "@agentclientprotocol/sdk";
import { resolveSelfCommand } from "@nanoboss/app-support";

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const REGISTERED_MCP_SERVER_NAME = "nanoboss";

type SupportedAgentId = "claude" | "codex" | "gemini" | "copilot";

export interface McpRegistrationResult {
  id: SupportedAgentId;
  name: string;
  status: "registered" | "not_installed" | "failed";
  details: string;
}

export interface McpServerStdioConfig {
  type: "stdio";
  name: string;
  command: string;
  args: string[];
  env: Array<{ name: string; value: string }>;
}

interface JsonObject {
  [key: string]: JsonValue;
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[];

function resolveMcpCommand(): ReturnType<typeof resolveSelfCommand> {
  return resolveSelfCommand("mcp");
}

export function buildGlobalMcpStdioServer(
  command = resolveMcpCommand(),
): McpServerStdioConfig {
  return {
    type: "stdio",
    name: REGISTERED_MCP_SERVER_NAME,
    command: command.command,
    args: command.args,
    env: [],
  };
}

export function registerSupportedAgentMcp(command = resolveMcpCommand()): McpRegistrationResult[] {
  return [
    registerMcpClaude(command),
    registerMcpCodex(command),
    registerMcpGemini(command),
    registerMcpCopilot(command),
  ];
}

function registerMcpClaude(command = resolveMcpCommand()): McpRegistrationResult {
  if (!commandExists("claude")) {
    return {
      id: "claude",
      name: "Claude Code",
      status: "not_installed",
      details: "claude CLI not installed",
    };
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
    return {
      id: "claude",
      name: "Claude Code",
      status: "registered",
      details: formatRegisteredDetails(command),
    };
  }

  return {
    id: "claude",
    name: "Claude Code",
    status: "failed",
    details: readProcessText(result) || "claude mcp add failed",
  };
}

function registerMcpCodex(command = resolveMcpCommand()): McpRegistrationResult {
  if (!commandExists("codex")) {
    return {
      id: "codex",
      name: "Codex",
      status: "not_installed",
      details: "codex CLI not installed",
    };
  }

  tryRun(["codex", "mcp", "remove", REGISTERED_MCP_SERVER_NAME]);

  const result = Bun.spawnSync({
    cmd: ["codex", "mcp", "add", REGISTERED_MCP_SERVER_NAME, "--", command.command, ...command.args],
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  if (result.exitCode === 0) {
    return {
      id: "codex",
      name: "Codex",
      status: "registered",
      details: formatRegisteredDetails(command),
    };
  }

  return {
    id: "codex",
    name: "Codex",
    status: "failed",
    details: readProcessText(result) || "codex mcp add failed",
  };
}

function registerMcpGemini(command = resolveMcpCommand()): McpRegistrationResult {
  if (!commandExists("gemini")) {
    return {
      id: "gemini",
      name: "Gemini CLI",
      status: "not_installed",
      details: "gemini CLI not installed",
    };
  }

  return writeJsonMcpConfig(
    {
      id: "gemini",
      name: "Gemini CLI",
      path: getGeminiConfigPath(),
    },
    {
      command: command.command,
      args: command.args,
      timeout: 30_000,
    },
  );
}

function registerMcpCopilot(command = resolveMcpCommand()): McpRegistrationResult {
  if (!commandExists("copilot")) {
    return {
      id: "copilot",
      name: "Copilot CLI",
      status: "not_installed",
      details: "copilot CLI not installed",
    };
  }

  return writeJsonMcpConfig(
    {
      id: "copilot",
      name: "Copilot CLI",
      path: getCopilotConfigPath(),
    },
    {
      type: "stdio",
      command: command.command,
      args: command.args,
    },
  );
}

function writeJsonMcpConfig(
  target: { id: SupportedAgentId; name: string; path: string },
  serverConfig: JsonObject,
): McpRegistrationResult {
  try {
    mkdirSync(dirname(target.path), { recursive: true });
    const config = readJsonObject(target.path);
    const servers = asMutableRecord(config.mcpServers);
    servers[REGISTERED_MCP_SERVER_NAME] = serverConfig;
    config.mcpServers = servers;
    writeFileSync(target.path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
    return {
      id: target.id,
      name: target.name,
      status: "registered",
      details: formatRegisteredDetails({ command: serverConfig.command as string, args: serverConfig.args as string[] }),
    };
  } catch (error) {
    return {
      id: target.id,
      name: target.name,
      status: "failed",
      details: error instanceof Error ? error.message : String(error),
    };
  }
}

function formatRegisteredDetails(command: { command: string; args: string[] }): string {
  return `registered ${REGISTERED_MCP_SERVER_NAME} -> ${command.command} ${command.args.join(" ")}`;
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

function asMutableRecord(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commandExists(command: string): boolean {
  return Boolean(Bun.which(command, { PATH: process.env.PATH }));
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

function getGeminiConfigPath(): string {
  return join(resolveHomeDir(), ".gemini", "settings.json");
}

function getCopilotConfigPath(): string {
  return join(resolveHomeDir(), ".copilot", "mcp-config.json");
}
