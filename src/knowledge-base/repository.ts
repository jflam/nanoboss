import { createHash } from "node:crypto";
import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";

export interface KnowledgeBasePaths {
  rawDir: string;
  wikiDir: string;
  sourcesDir: string;
  answersDir: string;
  manifestsDir: string;
  indexPath: string;
  logPath: string;
  sourcesManifestPath: string;
  answersManifestPath: string;
}

export interface RawSourceFile {
  sourceId: string;
  rawPath: string;
  absolutePath: string;
  contentHash: string;
  byteSize: number;
  modifiedAt: string;
}

export interface SourceManifestEntry {
  sourceId: string;
  rawPath: string;
  contentHash: string;
  byteSize: number;
  modifiedAt: string;
  compiledContentHash?: string;
  compiledAt?: string;
  summaryPath?: string;
  title?: string;
  abstract?: string;
  sourceType?: string;
  concepts: string[];
  tags: string[];
  questions: string[];
}

export interface AnswerManifestEntry {
  answerId: string;
  question: string;
  title: string;
  abstract: string;
  answerPath: string;
  createdAt: string;
  citedPages: string[];
}

export interface KnowledgeBaseIngestData {
  manifestPath: string;
  indexPath: string;
  sourceCount: number;
  allSourceIds: string[];
  changedSourceIds: string[];
  removedSourceIds: string[];
}

export interface KnowledgeBaseCompileData {
  sourceId: string;
  rawPath: string;
  summaryPath: string;
  title: string;
  status: "compiled" | "skipped";
}

export interface KnowledgeBaseAnswerData {
  answerId: string;
  answerPath: string;
  title: string;
  citedPages: string[];
}

export interface KnowledgeBaseRefreshData {
  sourceCount: number;
  changedSourceIds: string[];
  compiledSourceIds: string[];
  indexPath: string;
  logPath: string;
}

export function getKnowledgeBasePaths(cwd: string): KnowledgeBasePaths {
  const rawDir = join(cwd, "raw");
  const wikiDir = join(cwd, "wiki");
  const manifestsDir = join(cwd, ".kb", "manifests");
  return {
    rawDir,
    wikiDir,
    sourcesDir: join(wikiDir, "sources"),
    answersDir: join(wikiDir, "answers"),
    manifestsDir,
    indexPath: join(wikiDir, "index.md"),
    logPath: join(wikiDir, "log.md"),
    sourcesManifestPath: join(manifestsDir, "sources.json"),
    answersManifestPath: join(manifestsDir, "answers.json"),
  };
}

export async function ensureKnowledgeBaseLayout(cwd: string): Promise<KnowledgeBasePaths> {
  const paths = getKnowledgeBasePaths(cwd);
  await Promise.all([
    mkdir(paths.rawDir, { recursive: true }),
    mkdir(paths.sourcesDir, { recursive: true }),
    mkdir(paths.answersDir, { recursive: true }),
    mkdir(paths.manifestsDir, { recursive: true }),
  ]);

  await ensureFile(paths.sourcesManifestPath, "[]\n");
  await ensureFile(paths.answersManifestPath, "[]\n");
  await ensureFile(paths.indexPath, "# Knowledge Base Index\n\n");
  await ensureFile(paths.logPath, "# Knowledge Base Log\n\n");

  return paths;
}

export async function readSourcesManifest(cwd: string): Promise<SourceManifestEntry[]> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const raw = await readJsonArrayFile<SourceManifestEntry>(paths.sourcesManifestPath);
  return raw
    .map(normalizeSourceManifestEntry)
    .sort((left, right) => left.rawPath.localeCompare(right.rawPath));
}

export async function saveSourcesManifest(
  cwd: string,
  entries: SourceManifestEntry[],
): Promise<void> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const sorted = entries
    .map(normalizeSourceManifestEntry)
    .sort((left, right) => left.rawPath.localeCompare(right.rawPath));
  await writeJsonFile(paths.sourcesManifestPath, sorted);
}

export async function readAnswersManifest(cwd: string): Promise<AnswerManifestEntry[]> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const raw = await readJsonArrayFile<AnswerManifestEntry>(paths.answersManifestPath);
  return raw
    .map(normalizeAnswerManifestEntry)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

export async function saveAnswersManifest(
  cwd: string,
  entries: AnswerManifestEntry[],
): Promise<void> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const sorted = entries
    .map(normalizeAnswerManifestEntry)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  await writeJsonFile(paths.answersManifestPath, sorted);
}

export async function scanRawSources(
  cwd: string,
  requestedPath?: string,
): Promise<RawSourceFile[]> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const target = requestedPath
    ? resolveRequestedRawPath(paths, cwd, requestedPath)
    : paths.rawDir;
  const targetStats = await safeStat(target);
  if (!targetStats) {
    throw new Error(`Raw source path does not exist: ${requestedPath}`);
  }

  if (targetStats.isDirectory()) {
    const discovered = await walkRawDirectory(target, paths.rawDir);
    return discovered.sort((left, right) => left.rawPath.localeCompare(right.rawPath));
  }

  if (!targetStats.isFile()) {
    throw new Error(`Raw source path is not a regular file: ${requestedPath}`);
  }

  const relativeToRaw = toPosix(relative(paths.rawDir, target));
  if (isIgnoredRawRelativePath(relativeToRaw)) {
    return [];
  }

  return [await buildRawSourceFile(target, paths.rawDir)];
}

export function createSourceManifestEntry(
  rawSource: RawSourceFile,
  previous?: SourceManifestEntry,
): SourceManifestEntry {
  return normalizeSourceManifestEntry({
    sourceId: rawSource.sourceId,
    rawPath: rawSource.rawPath,
    contentHash: rawSource.contentHash,
    byteSize: rawSource.byteSize,
    modifiedAt: rawSource.modifiedAt,
    compiledContentHash: previous?.compiledContentHash,
    compiledAt: previous?.compiledAt,
    summaryPath: previous?.summaryPath,
    title: previous?.title,
    abstract: previous?.abstract,
    sourceType: previous?.sourceType,
    concepts: previous?.concepts ?? [],
    tags: previous?.tags ?? [],
    questions: previous?.questions ?? [],
  });
}

export function needsSourceCompilation(entry: SourceManifestEntry): boolean {
  return entry.compiledContentHash !== entry.contentHash || !entry.summaryPath;
}

export function normalizeStringList(values: string[]): string[] {
  return [...new Set(values.map((value) => collapseWhitespace(value)).filter(Boolean))];
}

export function normalizeTagList(values: string[]): string[] {
  return normalizeStringList(values.map((value) => value.toLowerCase()));
}

export function normalizeWikiPathList(values: string[]): string[] {
  return normalizeStringList(
    values
      .map((value) => toPosix(value.trim().replace(/^\.?\//, "")))
      .filter((value) => value.startsWith("wiki/")),
  );
}

export function normalizeDescriptionWords(words: string[], fallbackText: string): string[] {
  const normalized = [
    ...words.flatMap((word) => word.toLowerCase().match(/[a-z0-9]+/g) ?? []),
    ...((fallbackText.toLowerCase().match(/[a-z0-9]+/g)) ?? []),
  ].slice(0, 3);

  while (normalized.length < 3) {
    normalized.push("kb");
  }

  return normalized.slice(0, 3);
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function summarizeList(values: string[], maxItems = 3): string {
  if (values.length === 0) {
    return "none";
  }

  if (values.length <= maxItems) {
    return values.join(", ");
  }

  return `${values.slice(0, maxItems).join(", ")}, +${values.length - maxItems} more`;
}

export function sourceSummaryPath(sourceId: string): string {
  return toPosix(join("wiki", "sources", `${sourceId}.md`));
}

export async function writeDatedKnowledgeMarkdown(
  cwd: string,
  relativeDirectory: string,
  descriptionWords: string[],
  markdown: string,
): Promise<string> {
  const directory = join(cwd, relativeDirectory);
  await mkdir(directory, { recursive: true });

  const datePrefix = new Date().toISOString().slice(0, 10);
  const serial = await nextSerial(directory, datePrefix);
  const slug = normalizeDescriptionWords(descriptionWords, relativeDirectory).join("-");
  const relativePath = toPosix(join(relativeDirectory, `${datePrefix}-${serial}-${slug}.md`));

  await Bun.write(join(cwd, relativePath), ensureTrailingNewline(markdown));
  return relativePath;
}

export async function rebuildKnowledgeBaseIndex(cwd: string): Promise<string> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const sources = await readSourcesManifest(cwd);
  const answers = await readAnswersManifest(cwd);

  const lines = [
    "# Knowledge Base Index",
    "",
    "This catalog is maintained by nanoboss knowledge-base procedures.",
    "",
    `## Sources (${sources.length})`,
    "",
  ];

  if (sources.length === 0) {
    lines.push("_No raw sources have been ingested yet._", "");
  } else {
    for (const source of sources) {
      const label = source.title ? collapseWhitespace(source.title) : source.sourceId;
      const summary = source.abstract
        ? collapseWhitespace(source.abstract)
        : (needsSourceCompilation(source) ? "Pending compilation." : "No abstract recorded.");
      const detailLine = `source: \`${source.sourceId}\`; raw: \`${source.rawPath}\`; status: ${needsSourceCompilation(source) ? "pending compile" : "compiled"}`;

      if (source.summaryPath) {
        lines.push(`- [${escapeMarkdownLabel(label)}](${linkFromWiki(paths.wikiDir, cwd, source.summaryPath)}) — ${summary}`);
      } else {
        lines.push(`- \`${source.rawPath}\` (\`${source.sourceId}\`) — ${summary}`);
      }

      lines.push(`  - ${detailLine}`);
      if (source.tags.length > 0) {
        lines.push(`  - tags: ${source.tags.map((tag) => `\`${tag}\``).join(", ")}`);
      }
      if (source.concepts.length > 0) {
        lines.push(`  - concepts: ${source.concepts.join(", ")}`);
      }
    }

    lines.push("");
  }

  lines.push(`## Answers (${answers.length})`, "");

  if (answers.length === 0) {
    lines.push("_No stored answers yet._", "");
  } else {
    for (const answer of answers) {
      const title = collapseWhitespace(answer.title) || answer.answerId;
      const summary = collapseWhitespace(answer.abstract) || "No abstract recorded.";
      lines.push(`- [${escapeMarkdownLabel(title)}](${linkFromWiki(paths.wikiDir, cwd, answer.answerPath)}) — ${summary}`);
      lines.push(`  - question: ${truncateText(answer.question, 120)}`);
      if (answer.citedPages.length > 0) {
        lines.push(`  - cites: ${answer.citedPages.map((page) => `\`${page}\``).join(", ")}`);
      }
    }

    lines.push("");
  }

  await Bun.write(paths.indexPath, ensureTrailingNewline(lines.join("\n")));
  return toPosix(relative(cwd, paths.indexPath));
}

export async function appendKnowledgeBaseLog(
  cwd: string,
  action: string,
  title: string,
  details: string[],
): Promise<string> {
  const paths = await ensureKnowledgeBaseLayout(cwd);
  const existing = await Bun.file(paths.logPath).text();
  const lines = [
    `## [${new Date().toISOString()}] ${action} | ${collapseWhitespace(title) || action}`,
    "",
    ...details.map((detail) => `- ${detail}`),
  ];
  const content = existing.trimEnd().length > 0
    ? `${existing.trimEnd()}\n\n${lines.join("\n")}\n`
    : `${lines.join("\n")}\n`;

  await Bun.write(paths.logPath, content);
  return toPosix(relative(cwd, paths.logPath));
}

export function parseStructuredInput(prompt: string): Record<string, unknown> | undefined {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith("{")) {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected a JSON object");
    }

    return parsed as Record<string, unknown>;
  }

  if (!trimmed.includes("=")) {
    return undefined;
  }

  return Object.fromEntries(
    trimmed.split(/\s+/)
      .filter(Boolean)
      .map((token) => {
        const separator = token.indexOf("=");
        if (separator < 0) {
          throw new Error(`Expected key=value input; received ${token}`);
        }

        const key = token.slice(0, separator);
        const value = token.slice(separator + 1);
        return [key, coerceScalar(value)] as const;
      }),
  );
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionalBoolean(value: unknown, name: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (typeof value !== "boolean") {
    throw new Error(`${name} must be true or false`);
  }

  return value;
}

export function answerIdFromPath(answerPath: string): string {
  return basename(answerPath, extname(answerPath));
}

function normalizeSourceManifestEntry(entry: SourceManifestEntry): SourceManifestEntry {
  return {
    sourceId: collapseWhitespace(entry.sourceId),
    rawPath: toPosix(entry.rawPath),
    contentHash: collapseWhitespace(entry.contentHash),
    byteSize: entry.byteSize,
    modifiedAt: entry.modifiedAt,
    compiledContentHash: optionalString(entry.compiledContentHash),
    compiledAt: optionalString(entry.compiledAt),
    summaryPath: optionalString(entry.summaryPath)?.replaceAll("\\", "/"),
    title: optionalString(entry.title),
    abstract: optionalString(entry.abstract),
    sourceType: optionalString(entry.sourceType),
    concepts: normalizeStringList(entry.concepts),
    tags: normalizeTagList(entry.tags),
    questions: normalizeStringList(entry.questions),
  };
}

function normalizeAnswerManifestEntry(entry: AnswerManifestEntry): AnswerManifestEntry {
  return {
    answerId: collapseWhitespace(entry.answerId),
    question: collapseWhitespace(entry.question),
    title: collapseWhitespace(entry.title),
    abstract: collapseWhitespace(entry.abstract),
    answerPath: toPosix(entry.answerPath),
    createdAt: entry.createdAt,
    citedPages: normalizeWikiPathList(entry.citedPages),
  };
}

async function readJsonArrayFile<T>(path: string): Promise<T[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    return [];
  }

  const text = await file.text();
  if (!text.trim()) {
    return [];
  }

  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error(`Expected JSON array in ${path}`);
  }

  return parsed as T[];
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await Bun.write(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function ensureFile(path: string, content: string): Promise<void> {
  const file = Bun.file(path);
  if (!(await file.exists())) {
    await Bun.write(path, content);
  }
}

function resolveRequestedRawPath(
  paths: KnowledgeBasePaths,
  cwd: string,
  requestedPath: string,
): string {
  const trimmed = requestedPath.trim();
  const candidate = trimmed === "raw" || trimmed.startsWith("raw/")
    ? resolve(cwd, trimmed)
    : resolve(paths.rawDir, trimmed);
  const relativeToRaw = relative(paths.rawDir, candidate);
  if (relativeToRaw.startsWith("..")) {
    throw new Error(`Raw source path must stay under raw/: ${requestedPath}`);
  }

  return candidate;
}

async function walkRawDirectory(directory: string, rawDir: string): Promise<RawSourceFile[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: RawSourceFile[] = [];

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const absolutePath = join(directory, entry.name);
    const relativeToRaw = toPosix(relative(rawDir, absolutePath));
    if (isIgnoredRawRelativePath(relativeToRaw)) {
      continue;
    }

    if (entry.isDirectory()) {
      files.push(...await walkRawDirectory(absolutePath, rawDir));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    files.push(await buildRawSourceFile(absolutePath, rawDir));
  }

  return files;
}

async function buildRawSourceFile(absolutePath: string, rawDir: string): Promise<RawSourceFile> {
  const file = Bun.file(absolutePath);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const fileStats = await stat(absolutePath);
  const rawPath = toPosix(join("raw", relative(rawDir, absolutePath)));

  return {
    sourceId: makeSourceId(rawPath),
    rawPath,
    absolutePath,
    contentHash: createHash("sha256").update(bytes).digest("hex"),
    byteSize: fileStats.size,
    modifiedAt: fileStats.mtime.toISOString(),
  };
}

function isIgnoredRawRelativePath(relativePath: string): boolean {
  return relativePath === "assets" || relativePath.startsWith("assets/");
}

function makeSourceId(rawPath: string): string {
  const stem = rawPath
    .replace(/^raw\//, "")
    .replace(/\.[^./]+$/, "")
    .replaceAll("/", "-");
  const slug = slugify(stem) || "source";
  const suffix = createHash("sha1").update(rawPath).digest("hex").slice(0, 8);
  return `${slug}-${suffix}`;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function nextSerial(directory: string, datePrefix: string): Promise<number> {
  const entries = await readdir(directory, { withFileTypes: true });
  const matcher = new RegExp(`^${escapeRegExp(datePrefix)}-(\\d+)-`);
  let maxSerial = 0;

  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }

    const match = entry.name.match(matcher);
    if (!match) {
      continue;
    }

    const serial = Number.parseInt(match[1], 10);
    if (Number.isFinite(serial)) {
      maxSerial = Math.max(maxSerial, serial);
    }
  }

  return maxSerial + 1;
}

function linkFromWiki(wikiDir: string, cwd: string, repoRelativePath: string): string {
  const absoluteTarget = join(cwd, repoRelativePath);
  return toPosix(relative(wikiDir, absoluteTarget));
}

function escapeMarkdownLabel(value: string): string {
  return value.replaceAll("[", "\\[").replaceAll("]", "\\]");
}

function truncateText(value: string, maxLength: number): string {
  const compact = collapseWhitespace(value);
  if (compact.length <= maxLength) {
    return compact;
  }

  return `${compact.slice(0, maxLength - 3)}...`;
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(path: string): string {
  return path.replaceAll("\\", "/");
}

async function safeStat(path: string) {
  try {
    return await stat(path);
  } catch {
    return undefined;
  }
}

function coerceScalar(value: string): unknown {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  if (/^\d+$/.test(value)) {
    return Number(value);
  }

  return value;
}
