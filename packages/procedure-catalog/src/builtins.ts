import type {
  KernelValue,
  Procedure,
  ProcedureMetadata,
  ProcedureRegistryLike,
} from "@nanoboss/procedure-sdk";

export const CREATE_PROCEDURE_METADATA = {
  name: "create",
  description: "Create a new procedure from natural language",
  inputHint: "Describe the procedure you want to create",
} satisfies ProcedureMetadata;

interface BuiltinDefinition extends ProcedureMetadata {
  load: () => Promise<Procedure>;
  supportsResume?: boolean;
}

const BUILTIN_DEFINITIONS = [
  {
    name: "default",
    description: "Pass prompt through to the downstream agent",
    load: async () => (await import("../../../procedures/default.ts")).default,
  },
  {
    name: "autoresearch",
    description: "Show the explicit autoresearch v1 command surface",
    load: async () => (await import("../../../procedures/autoresearch/index.ts")).default,
  },
  {
    name: "autoresearch/start",
    description: "Create a new autoresearch session and run a bounded foreground loop",
    inputHint: "Optimization goal",
    load: async () => (await import("../../../procedures/autoresearch/start.ts")).default,
  },
  {
    name: "autoresearch/continue",
    description: "Continue the repo-local autoresearch session in the foreground",
    inputHint: "Optional continuation note",
    load: async () => (await import("../../../procedures/autoresearch/continue.ts")).default,
  },
  {
    name: "autoresearch/status",
    description: "Inspect the current repo-local autoresearch session",
    load: async () => (await import("../../../procedures/autoresearch/status.ts")).default,
  },
  {
    name: "autoresearch/clear",
    description: "Delete repo-local autoresearch state after the loop is stopped",
    load: async () => (await import("../../../procedures/autoresearch/clear.ts")).default,
  },
  {
    name: "autoresearch/finalize",
    description: "Split kept autoresearch wins into review branches from the merge-base",
    load: async () => (await import("../../../procedures/autoresearch/finalize.ts")).default,
  },
  {
    name: "kb/ingest",
    description: "Scan raw sources and update knowledge-base manifests",
    inputHint: "Optional raw path or path=raw/article.md",
    load: async () => (await import("../../../procedures/kb/ingest.ts")).default,
  },
  {
    name: "kb/compile-source",
    description: "Compile one ingested source into a durable wiki page",
    inputHint: "sourceId=<id> or path=raw/article.md",
    load: async () => (await import("../../../procedures/kb/compile-source.ts")).default,
  },
  {
    name: "kb/compile-concepts",
    description: "Compile concept pages from source summaries",
    inputHint: "Optional concept=<id-or-name>",
    load: async () => (await import("../../../procedures/kb/compile-concepts.ts")).default,
  },
  {
    name: "kb/link",
    description: "Rebuild KB indexes, backlinks, and structural reports",
    inputHint: "Optional suppressLog=true",
    load: async () => (await import("../../../procedures/kb/link.ts")).default,
  },
  {
    name: "kb/render",
    description: "Render derived reports or decks from stored KB pages",
    inputHint: "kind=report|deck page=wiki/concepts/foo.md",
    load: async () => (await import("../../../procedures/kb/render.ts")).default,
  },
  {
    name: "kb/health",
    description: "Check KB consistency and write a deterministic repair queue",
    load: async () => (await import("../../../procedures/kb/health.ts")).default,
  },
  {
    name: "kb/refresh",
    description: "Refresh the knowledge base from raw sources",
    inputHint: "Optional raw path or path=raw/article.md",
    load: async () => (await import("../../../procedures/kb/refresh.ts")).default,
  },
  {
    name: "kb/answer",
    description: "Answer a question against the compiled knowledge base",
    inputHint: "Question to answer from wiki/index.md and compiled pages",
    load: async () => (await import("../../../procedures/kb/answer.ts")).default,
  },
  {
    name: "linter",
    description: "Fix all linter errors in the project",
    inputHint: "Optional focus area or instructions",
    load: async () => (await import("../../../procedures/linter.ts")).default,
  },
  {
    name: "model",
    description: "Set or inspect the default agent/model for this session",
    inputHint: "[agent] [model]",
    executionMode: "harness",
    load: async () => (await import("../../../procedures/model.ts")).default,
  },
  {
    name: "nanoboss/pre-commit-checks",
    description: "Run or replay the repo pre-commit validation command",
    supportsResume: true,
    load: async () => (await import("../../../procedures/nanoboss/pre-commit-checks.ts")).default,
  },
  {
    name: "nanoboss/commit",
    description: "Run repo pre-commit checks, then create a descriptive git commit",
    load: async () => (await import("../../../procedures/nanoboss/commit.ts")).default,
  },
  {
    name: "simplify",
    description: "Find and apply simplifications one opportunity at a time",
    inputHint: "Optional focus or scope",
    executionMode: "harness",
    supportsResume: true,
    load: async () => (await import("../../../procedures/simplify.ts")).default,
  },
  {
    name: "simplify2",
    description: "Model conceptual simplification with explicit checkpoints and a bounded multi-step loop",
    inputHint: "Optional simplify focus; omit to choose a saved focus",
    executionMode: "harness",
    supportsResume: true,
    load: async () => (await import("../../../procedures/simplify2.ts")).default,
  },
  {
    name: "tokens",
    description: "Show the latest token/context metrics for the default agent session",
    load: async () => (await import("../../../procedures/tokens.ts")).default,
  },
  {
    name: "second-opinion",
    description: "Get a first answer using the current default model, then ask Codex to critique and revise it",
    inputHint: "Question or task to review",
    load: async () => (await import("../../../procedures/second-opinion.ts")).default,
  },
] as const satisfies readonly BuiltinDefinition[];

export function loadBuiltinProcedures(registry: ProcedureRegistryLike): void {
  for (const definition of BUILTIN_DEFINITIONS) {
    if (!registry.get(definition.name)) {
      registry.register(createLazyBuiltinProcedure(definition));
    }
  }

  if (!registry.get(CREATE_PROCEDURE_METADATA.name)) {
    registry.register(
      createLazyBuiltinProcedure({
        ...CREATE_PROCEDURE_METADATA,
        load: async () => {
          const { createCreateProcedure } = await import("../../../procedures/create.ts");
          return createCreateProcedure(registry);
        },
      }),
    );
  }
}

function createLazyBuiltinProcedure(definition: BuiltinDefinition): Procedure {
  let loadPromise: Promise<Procedure> | undefined;

  const ensureLoaded = async (): Promise<Procedure> => {
    if (!loadPromise) {
      loadPromise = definition.load().then((procedure) => {
        if (procedure.name !== definition.name) {
          throw new Error(
            `Builtin procedure module loaded as /${procedure.name} but was registered as /${definition.name}`,
          );
        }
        return procedure;
      }).catch((error: unknown) => {
        loadPromise = undefined;
        throw error;
      });
    }

    return await loadPromise;
  };

  return {
    name: definition.name,
    description: definition.description,
    inputHint: definition.inputHint,
    executionMode: definition.executionMode,
    async execute(prompt, ctx) {
      const procedure = await ensureLoaded();
      return await procedure.execute(prompt, ctx);
    },
    ...(definition.supportsResume
      ? {
          async resume(prompt: string, state: KernelValue, ctx: Parameters<NonNullable<Procedure["resume"]>>[2]) {
            const procedure = await ensureLoaded();
            if (!procedure.resume) {
              throw new Error(`Builtin procedure /${definition.name} does not support continuation.`);
            }
            return await procedure.resume(prompt, state, ctx);
          },
        }
      : {}),
  };
}
