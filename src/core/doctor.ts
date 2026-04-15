import { registerSupportedAgentMcp } from "@nanoboss/adapters-mcp";

interface DoctorOptions {
  showHelp: boolean;
  register: boolean;
}

interface AgentDoctorRow {
  name: string;
  installed: boolean;
  version?: string;
  acp: string;
  globalMcp: string;
}

export function parseDoctorOptions(argv: string[]): DoctorOptions {
  let showHelp = false;
  let register = false;

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      showHelp = true;
      continue;
    }

    if (arg === "--register") {
      register = true;
      continue;
    }

    throw new Error(`Unknown doctor option: ${arg}`);
  }

  return { showHelp, register };
}

export async function runDoctorCommand(argv: string[] = []): Promise<void> {
  const options = parseDoctorOptions(argv);
  if (options.showHelp) {
    printDoctorHelp();
    return;
  }

  if (options.register) {
    printRegistrationReport(registerSupportedAgentMcp());
    process.stdout.write("\n");
  }

  printDoctorReport(collectDoctorRows());
}

export function printDoctorHelp(): void {
  process.stdout.write([
    "Usage: nanoboss doctor [--register]",
    "",
    "Shows installed agent status, ACP transport readiness, and the standard global nanoboss MCP setup path.",
    "",
    "Options:",
    "  --register          Register the global nanoboss MCP stdio server for Claude, Codex, Gemini, and Copilot.",
    "                      This repairs stale, missing, or broken nanoboss MCP registrations.",
    "  -h, --help          Show this help text",
    "",
  ].join("\n"));
}

function collectDoctorRows(): AgentDoctorRow[] {
  return [
    buildDoctorRow({
      name: "Claude Code",
      command: "claude",
      versionArgs: [["--version"]],
      acp: describeBroker({
        brokerCommand: "claude-code-acp",
        packageName: "@zed-industries/claude-code-acp",
      }),
    }),
    buildDoctorRow({
      name: "Codex",
      command: "codex",
      versionArgs: [["--version"]],
      acp: describeBroker({
        brokerCommand: "codex-acp",
        packageName: "@zed-industries/codex-acp",
      }),
    }),
    buildDoctorRow({
      name: "Gemini CLI",
      command: "gemini",
      versionArgs: [["--version"], ["-v"]],
      acp: "native ACP",
    }),
    buildDoctorRow({
      name: "Copilot CLI",
      command: "copilot",
      versionArgs: [["--version"]],
      acp: "native ACP",
    }),
  ];
}

function buildDoctorRow(params: {
  name: string;
  command: string;
  versionArgs: string[][];
  acp: string;
}): AgentDoctorRow {
  const installed = commandExists(params.command);
  const version = installed ? readVersion(params.command, params.versionArgs) : undefined;

  return {
    name: params.name,
    installed,
    version,
    acp: installed ? formatAcpLabel(params.acp, version) : "-",
    globalMcp: installed ? "[setup] nanoboss doctor --register" : "-",
  };
}

function printDoctorReport(rows: AgentDoctorRow[]): void {
  process.stdout.write("Agents                    ACP                     Global MCP\n");
  for (const row of rows) {
    process.stdout.write(
      `  ${padRight(row.name, 24)} ${padRight(row.acp, 22)} ${row.globalMcp}\n`,
    );
  }
}

function printRegistrationReport(results: ReturnType<typeof registerSupportedAgentMcp>): void {
  process.stdout.write([
    "Registered nanoboss MCP for supported agents.",
    "This configures a working global `nanoboss` MCP stdio server and repairs stale broken registrations.",
    "",
    "Registration results:",
  ].join("\n"));

  for (const result of results) {
    const label = result.status === "registered"
      ? "[registered]"
      : result.status === "not_installed"
        ? "[skip]"
        : "[failed]";
    process.stdout.write(`\n  ${padRight(result.name, 12)} ${padRight(label, 12)} ${result.details}`);
  }

  process.stdout.write("\n");
}

function formatAcpLabel(acp: string, version?: string): string {
  if (acp.startsWith("native")) {
    return version ? `native ${version}` : "native";
  }

  return version ? `${acp} (${version})` : acp;
}

function describeBroker(params: { brokerCommand: string; packageName: string }): string {
  if (!commandExists(params.brokerCommand)) {
    return "zed ACP broker missing";
  }

  const version = readNpmPackageVersion(params.packageName);
  return version ? `zed ACP broker ${version}` : "zed ACP broker";
}

function commandExists(command: string): boolean {
  return Boolean(Bun.which(command, { PATH: process.env.PATH }));
}

function readVersion(command: string, candidates: string[][]): string | undefined {
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

function readProcessText(result: Bun.SyncSubprocess): string {
  const decoder = new TextDecoder();
  return `${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`.trim();
}

function padRight(value: string, width: number): string {
  return value.length >= width ? value : `${value}${" ".repeat(width - value.length)}`;
}
