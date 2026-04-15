import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

export function resolveRepoArtifactDir(repoRoot: string, ...segments: string[]): string {
  return join(repoRoot, ...segments);
}

export async function ensureDirectories(paths: string[]): Promise<void> {
  await Promise.all(paths.map((path) => mkdir(path, { recursive: true })));
}

export async function ensureFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  if (!existsSync(path)) {
    writeFileSync(path, content, "utf8");
  }
}

export function writeTextFileAtomicSync(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.tmp`;
  writeFileSync(tempPath, content, "utf8");
  renameSync(tempPath, path);
}

export function writeJsonFileAtomicSync(path: string, value: unknown): void {
  writeTextFileAtomicSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  writeJsonFileAtomicSync(path, value);
}
