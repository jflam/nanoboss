import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  extractFailureDetails,
  parseJunitReport,
  renderCompactTestOutput,
} from "../src/util/compact-test.ts";

const tempDir = mkdtempSync(join(tmpdir(), "nanoboss-compact-test-"));
const junitPath = join(tempDir, "report.xml");
const args = Bun.argv.slice(2);

try {
  const { stdout, stderr, exitCode } = await runBunTest(args);
  const rawOutput = [stdout, stderr].filter(Boolean).join("\n");
  const xml = existsSync(junitPath) ? readFileSync(junitPath, "utf8") : "";
  const report = xml ? parseJunitReport(xml) : undefined;
  const failureDetails = extractFailureDetails(rawOutput);

  if (!report) {
    process.stdout.write(rawOutput);
    process.exitCode = exitCode;
  } else {
    process.stdout.write(renderCompactTestOutput(report, failureDetails));
    process.exitCode = exitCode;
  }
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

async function runBunTest(args: string[]): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  const child = spawn("bun", [
    "test",
    "--only-failures",
    "--reporter=junit",
    "--reporter-outfile",
    junitPath,
    ...args,
  ], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NO_COLOR: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => {
      resolve(code ?? 1);
    });
  });

  return { stdout, stderr, exitCode };
}
