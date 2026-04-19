import type { BunPlugin } from "bun";
import typiaTransform from "@typia/transform";
import ts from "typescript";
import { dirname, resolve } from "node:path";

const TYPESCRIPT_FILTER = /\.[cm]?[jt]sx?$/;
const NODE_MODULES_SEGMENT = /(^|[/\\])node_modules([/\\]|$)/;
const printer = ts.createPrinter();

interface TypiaTransformOptions {
  finite?: boolean;
  numeric?: boolean;
  functional?: boolean;
  undefined?: boolean;
}

interface ResolvedTypeScriptConfig {
  compilerOptions: ts.CompilerOptions;
  typiaOptions: TypiaTransformOptions | undefined;
}

const DEFAULT_COMPILER_OPTIONS: ts.CompilerOptions = {
  target: ts.ScriptTarget.ESNext,
  module: ts.ModuleKind.Preserve,
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  moduleDetection: ts.ModuleDetectionKind.Force,
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  noEmit: true,
  strict: true,
  strictNullChecks: true,
  skipLibCheck: true,
  types: ["bun"],
};

const tsconfigCache = new Map<string, ResolvedTypeScriptConfig>();

export function createTypiaBunPlugin(): BunPlugin {
  return {
    name: "nanoboss-typia",
    setup(build) {
      build.onLoad({ filter: TYPESCRIPT_FILTER }, async (args) => {
        if (shouldSkipTypiaTransform(args.path)) {
          return undefined;
        }

        const source = await Bun.file(args.path).text();
        return {
          contents: transformTypeScriptWithTypia(args.path, source),
        };
      });
    },
  };
}

function shouldSkipTypiaTransform(path: string): boolean {
  return path.endsWith(".d.ts") || NODE_MODULES_SEGMENT.test(path);
}

function transformTypeScriptWithTypia(path: string, source: string): string {
  const resolvedPath = resolve(path);
  const { compilerOptions, typiaOptions } = resolveTypeScriptConfig(resolvedPath);
  const sourceFile = ts.createSourceFile(
    resolvedPath,
    source,
    compilerOptions.target ?? ts.ScriptTarget.ESNext,
  );
  const host = ts.createCompilerHost(compilerOptions);
  const originalGetSourceFile = host.getSourceFile.bind(host);

  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    if (resolve(fileName) === resolvedPath) {
      return sourceFile;
    }

    return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
  };

  const program = ts.createProgram([resolvedPath], compilerOptions, host);
  const diagnostics: ts.Diagnostic[] = [];
  const transformer = typiaTransform(program, typiaOptions, {
    addDiagnostic(diagnostic) {
      diagnostics.push(diagnostic);
      return diagnostics.length;
    },
  });
  const result = ts.transform(sourceFile, [transformer], {
    ...program.getCompilerOptions(),
    sourceMap: true,
    inlineSources: true,
  });

  try {
    const errors = diagnostics.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
    if (errors.length > 0) {
      throw new Error(formatTypeScriptDiagnostics(errors));
    }

    const transformed = result.transformed.find((file) => resolve(file.fileName) === resolvedPath);
    if (!transformed) {
      throw new Error(`Typia transform did not produce output for ${path}`);
    }

    return printer.printFile(transformed);
  } finally {
    result.dispose();
  }
}

function resolveTypeScriptConfig(path: string): ResolvedTypeScriptConfig {
  const configPath = ts.findConfigFile(dirname(path), (fileName) => ts.sys.fileExists(fileName));
  const cacheKey = configPath ?? "__default__";
  const cached = tsconfigCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const resolved = configPath
    ? readTypeScriptConfig(configPath)
    : {
        compilerOptions: { ...DEFAULT_COMPILER_OPTIONS },
        typiaOptions: undefined,
      };

  tsconfigCache.set(cacheKey, resolved);
  return resolved;
}

function readTypeScriptConfig(configPath: string): ResolvedTypeScriptConfig {
  const configFile = ts.readConfigFile(configPath, (fileName) => ts.sys.readFile(fileName));
  if (configFile.error) {
    throw new Error(formatTypeScriptDiagnostics([configFile.error]));
  }

  const parsed = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    dirname(configPath),
    DEFAULT_COMPILER_OPTIONS,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(formatTypeScriptDiagnostics(parsed.errors));
  }

  const compilerOptions = { ...parsed.options } as ts.CompilerOptions & { plugins?: unknown[] };
  delete compilerOptions.plugins;

  return {
    compilerOptions,
    typiaOptions: readTypiaTransformOptions(configFile.config),
  };
}

function readTypiaTransformOptions(config: unknown): TypiaTransformOptions | undefined {
  if (!config || typeof config !== "object") {
    return undefined;
  }

  const compilerOptions = extractRecord(config, "compilerOptions");
  const plugins = compilerOptions ? extractArray(compilerOptions, "plugins") : undefined;
  if (!plugins) {
    return undefined;
  }

  for (const plugin of plugins) {
    if (!plugin || typeof plugin !== "object") {
      continue;
    }

    const transform = extractString(plugin, "transform");
    if (transform !== "typia/lib/transform") {
      continue;
    }

    const options: TypiaTransformOptions = {};
    const finite = extractBoolean(plugin, "finite");
    const numeric = extractBoolean(plugin, "numeric");
    const functional = extractBoolean(plugin, "functional");
    const allowUndefined = extractBoolean(plugin, "undefined");

    if (finite !== undefined) {
      options.finite = finite;
    }
    if (numeric !== undefined) {
      options.numeric = numeric;
    }
    if (functional !== undefined) {
      options.functional = functional;
    }
    if (allowUndefined !== undefined) {
      options.undefined = allowUndefined;
    }

    return options;
  }

  return undefined;
}

function extractRecord(value: object, key: string): Record<string, unknown> | undefined {
  const entry = (value as Record<string, unknown>)[key];
  return typeof entry === "object" && entry !== null && !Array.isArray(entry)
    ? entry as Record<string, unknown>
    : undefined;
}

function extractArray(value: Record<string, unknown>, key: string): unknown[] | undefined {
  const entry = value[key];
  return Array.isArray(entry) ? entry : undefined;
}

function extractString(value: object, key: string): string | undefined {
  if (!(key in value)) {
    return undefined;
  }

  const entry = value[key as keyof typeof value];
  return typeof entry === "string" ? entry : undefined;
}

function extractBoolean(value: object, key: string): boolean | undefined {
  if (!(key in value)) {
    return undefined;
  }

  const entry = value[key as keyof typeof value];
  return typeof entry === "boolean" ? entry : undefined;
}

function formatTypeScriptDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName(fileName) {
      return fileName;
    },
    getCurrentDirectory() {
      return process.cwd();
    },
    getNewLine() {
      return "\n";
    },
  }).trim();
}
