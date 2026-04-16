import { existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string | undefined>;
}

interface PackageTaskFailure {
  name: string;
  output: string;
}

const task = process.argv[2];

if (!task) {
  console.error("Usage: bun run scripts/run-package-task.ts <task>");
  process.exit(1);
}

const packagesRoot = join(process.cwd(), "packages");
const packageDirs = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(packagesRoot, entry.name))
  .filter((packageDir) => existsSync(join(packageDir, "package.json")))
  .sort((left, right) => basename(left).localeCompare(basename(right)));

const concurrency = Math.min(
  packageDirs.length,
  Math.max(1, Number(process.env.NANOBOSS_PACKAGE_TASK_CONCURRENCY ?? "4") || 4),
);
const failures: PackageTaskFailure[] = [];
let completed = 0;
let nextIndex = 0;

console.log(`Running "${task}" in ${packageDirs.length} packages with concurrency ${concurrency}.`);

async function runPackageTask(packageDir: string): Promise<void> {
  const manifest = await Bun.file(join(packageDir, "package.json")).json() as PackageManifest;
  const name = manifest.name ?? basename(packageDir);

  if (!manifest.scripts?.[task]) {
    failures.push({
      name,
      output: `Missing scripts.${task} in ${join(packageDir, "package.json")}`,
    });
    console.log(`[${name}] missing script`);
    return;
  }

  console.log(`[${name}] starting`);

  const processHandle = Bun.spawn({
    cmd: ["bun", "run", task],
    cwd: packageDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
    processHandle.exited,
  ]);

  if (exitCode === 0) {
    completed += 1;
    console.log(`[${name}] ok`);
    return;
  }

  failures.push({
    name,
    output: [stdout.trim(), stderr.trim()].filter(Boolean).join("\n"),
  });
  console.log(`[${name}] failed`);
}

await Promise.all(
  Array.from({ length: concurrency }, async () => {
    while (nextIndex < packageDirs.length) {
      const packageDir = packageDirs[nextIndex];
      nextIndex += 1;
      await runPackageTask(packageDir);
    }
  }),
);

if (failures.length > 0) {
  console.error(`\n${failures.length} package task${failures.length === 1 ? "" : "s"} failed for "${task}".`);
  for (const failure of failures) {
    console.error(`\n[${failure.name}]`);
    if (failure.output.length > 0) {
      console.error(failure.output);
    }
  }
  process.exit(1);
}

console.log(`Completed "${task}" in ${completed} packages.`);
