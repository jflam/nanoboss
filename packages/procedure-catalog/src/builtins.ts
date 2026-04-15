import autoresearchProcedure from "../../../procedures/autoresearch/index.ts";
import autoresearchContinueProcedure from "../../../procedures/autoresearch/continue.ts";
import autoresearchClearProcedure from "../../../procedures/autoresearch/clear.ts";
import autoresearchFinalizeProcedure from "../../../procedures/autoresearch/finalize.ts";
import autoresearchStartProcedure from "../../../procedures/autoresearch/start.ts";
import autoresearchStatusProcedure from "../../../procedures/autoresearch/status.ts";
import { CREATE_PROCEDURE_METADATA, createCreateProcedure } from "../../../procedures/create.ts";
import defaultProcedure from "../../../procedures/default.ts";
import kbAnswerProcedure from "../../../procedures/kb/answer.ts";
import kbCompileConceptsProcedure from "../../../procedures/kb/compile-concepts.ts";
import kbCompileSourceProcedure from "../../../procedures/kb/compile-source.ts";
import kbHealthProcedure from "../../../procedures/kb/health.ts";
import kbIngestProcedure from "../../../procedures/kb/ingest.ts";
import kbLinkProcedure from "../../../procedures/kb/link.ts";
import kbRenderProcedure from "../../../procedures/kb/render.ts";
import kbRefreshProcedure from "../../../procedures/kb/refresh.ts";
import linterProcedure from "../../../procedures/linter.ts";
import modelProcedure from "../../../procedures/model.ts";
import nanobossCommitProcedure from "../../../procedures/nanoboss/commit.ts";
import nanobossPreCommitChecksProcedure from "../../../procedures/nanoboss/pre-commit-checks.ts";
import secondOpinionProcedure from "../../../procedures/second-opinion.ts";
import simplifyProcedure from "../../../procedures/simplify.ts";
import simplify2Procedure from "../../../procedures/simplify2.ts";
import tokensProcedure from "../../../procedures/tokens.ts";

import type { ProcedureRegistryLike } from "@nanoboss/procedure-sdk";

const BUILTIN_PROCEDURES = [
  defaultProcedure,
  autoresearchProcedure,
  autoresearchStartProcedure,
  autoresearchContinueProcedure,
  autoresearchStatusProcedure,
  autoresearchClearProcedure,
  autoresearchFinalizeProcedure,
  kbIngestProcedure,
  kbCompileSourceProcedure,
  kbCompileConceptsProcedure,
  kbLinkProcedure,
  kbRenderProcedure,
  kbHealthProcedure,
  kbRefreshProcedure,
  kbAnswerProcedure,
  linterProcedure,
  modelProcedure,
  nanobossPreCommitChecksProcedure,
  nanobossCommitProcedure,
  simplifyProcedure,
  simplify2Procedure,
  tokensProcedure,
  secondOpinionProcedure,
] as const;

export { CREATE_PROCEDURE_METADATA };

export function loadBuiltinProcedures(registry: ProcedureRegistryLike): void {
  for (const procedure of BUILTIN_PROCEDURES) {
    if (!registry.get(procedure.name)) {
      registry.register(procedure);
    }
  }

  const createBuiltin = registry.get(CREATE_PROCEDURE_METADATA.name) ?? createCreateProcedure(registry);
  if (!registry.get(createBuiltin.name)) {
    registry.register(createBuiltin);
  }
}
