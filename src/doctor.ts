import {
  collectDoctorRows,
  describeMcpStatus,
  registerMcpClaude,
  registerMcpCodex,
  registerMcpCopilot,
  registerMcpGemini,
  type AgentDoctorRow,
  type McpConfigStatus,
  type McpRegistrationResult,
} from "./mcp-registration.ts";

interface DoctorOptions {
  register: boolean;
}

export function parseDoctorOptions(argv: string[]): DoctorOptions {
  let register = false;

  for (const arg of argv) {
    if (arg === "--register") {
      register = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printDoctorHelp();
      process.exit(0);
    }

    throw new Error(`Unknown doctor option: ${arg}`);
  }

  return { register };
}

export async function runDoctorCommand(argv: string[] = []): Promise<void> {
  const options = parseDoctorOptions(argv);

  if (options.register) {
    process.stdout.write("Registering nanoboss MCP with installed agents\n");
    printRegistration("Claude Code", registerMcpClaude());
    printRegistration("Codex", registerMcpCodex());
    printRegistration("Gemini CLI", registerMcpGemini());
    printRegistration("Copilot CLI", registerMcpCopilot());
    process.stdout.write("\n");
  }

  printDoctorReport(collectDoctorRows());
}

export function printDoctorHelp(): void {
  process.stdout.write([
    "Usage: nanoboss doctor [--register]",
    "",
    "Options:",
    "  --register           Register the static nanoboss MCP server with installed agents",
    "  -h, --help           Show this help text",
    "",
  ].join("\n"));
}

function printRegistration(name: string, result: McpRegistrationResult): void {
  switch (result.kind) {
    case "success":
      process.stdout.write(`  [ok] ${name}\n`);
      break;
    case "not_installed":
      process.stdout.write(`  [skip] ${name}\n`);
      break;
    case "failed":
      process.stdout.write(`  [fail] ${name}: ${result.message}\n`);
      break;
  }
}

function printDoctorReport(rows: AgentDoctorRow[]): void {
  process.stdout.write("Agents                    ACP                     MCP\n");
  for (const row of rows) {
    process.stdout.write(
      `  ${padRight(row.name, 24)} ${padRight(describeAcp(row), 22)} ${describeMcp(row.mcp)}\n`,
    );
  }
}

function describeAcp(row: AgentDoctorRow): string {
  if (!row.installed) {
    return "-";
  }

  const version = row.version ? ` ${row.version}` : "";
  return row.acp.startsWith("native")
    ? `native${version}`
    : `${row.acp}${version ? ` (${row.version})` : ""}`;
}

function describeMcp(status: McpConfigStatus): string {
  switch (status.kind) {
    case "configured":
      return status.description === "stdio proxy" ? "[ok]" : `[warn] ${describeMcpStatus(status)}`;
    case "not_configured":
      return "[missing]";
    case "error":
      return `[error] ${status.message}`;
  }
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}
