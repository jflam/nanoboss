import { execFileSync } from "node:child_process";

interface BuildGlobals {
  __NANOBOSS_BUILD_COMMIT__?: string;
}

let cachedCommit: string | undefined;

export function getBuildCommit(): string {
  if (cachedCommit) {
    return cachedCommit;
  }

  const definedCommit = (globalThis as BuildGlobals).__NANOBOSS_BUILD_COMMIT__;
  if (definedCommit?.trim()) {
    cachedCommit = definedCommit.trim();
    return cachedCommit;
  }

  const envCommit = process.env.NANOBOSS_BUILD_COMMIT?.trim();
  if (envCommit) {
    cachedCommit = envCommit;
    return cachedCommit;
  }

  try {
    cachedCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return cachedCommit || "unknown";
  } catch {
    cachedCommit = "unknown";
    return cachedCommit;
  }
}

export function getBuildLabel(): string {
  return `nanoboss-${getBuildCommit()}`;
}
