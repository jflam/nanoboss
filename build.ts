import UnpluginTypia from "@ryoppippi/unplugin-typia/bun";
import { execFileSync } from "node:child_process";
import { accessSync, chmodSync, constants, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { resolveNanobossInstallDir } from "./src/install-path.ts";

const outfile = "./dist/nanoboss";
const buildCommit = resolveBuildCommit();

const result = await Bun.build({
  entrypoints: ["./nanoboss.ts"],
  define: {
    "globalThis.__NANOBOSS_BUILD_COMMIT__": JSON.stringify(buildCommit),
  },
  plugins: [
    UnpluginTypia({ log: false }),
  ],
  // unplugin-typia has an optional dynamic import of `svelte/compiler` for
  // Svelte sources. nanoboss command modules are TypeScript-only, so keep that
  // optional path external instead of forcing Bun to resolve Svelte at bundle time.
  external: ["svelte/compiler"],
  compile: {
    outfile,
    autoloadBunfig: true,
    autoloadTsconfig: false,
    autoloadPackageJson: false,
  },
});

if (!result.success) {
  for (const log of result.logs) {
    console.error(log);
  }
  process.exitCode = 1;
} else {
  const installDir = resolveNanobossInstallDir({
    overrideDir: Bun.env.NANOBOSS_INSTALL_DIR,
  });
  const target = join(installDir, "nanoboss");

  mkdirSync(dirname(outfile), { recursive: true });
  mkdirSync(installDir, { recursive: true });
  copyFileSync(outfile, target);
  chmodSync(target, 0o755);

  console.log(`Built nanoboss-${buildCommit}`);
  console.log(`Installed nanoboss to ${target}`);

  try {
    accessSync(installDir, constants.W_OK | constants.X_OK);
  } catch {
    console.warn(`Warning: ${installDir} may not be writable/executable in this environment.`);
  }
}

function resolveBuildCommit(): string {
  try {
    const commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!commit) {
      return "unknown";
    }

    const dirty = isDirtyWorkingTree() ? "-dirty" : "";
    return `${commit}${dirty}`;
  } catch {
    return "unknown";
  }
}

function isDirtyWorkingTree(): boolean {
  try {
    execFileSync("git", ["diff", "--quiet", "--ignore-submodules", "HEAD", "--"], {
      cwd: process.cwd(),
      stdio: "ignore",
    });
    return false;
  } catch {
    return true;
  }
}
