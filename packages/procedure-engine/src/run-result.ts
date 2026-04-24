import { createRef } from "@nanoboss/contracts";
import type { StoredRunResult } from "@nanoboss/store";
import { inferDataShape } from "@nanoboss/procedure-sdk";
import type {
  AgentTokenUsage,
  DownstreamAgentSelection,
  KernelValue,
  RunRecord,
  RunResult,
} from "@nanoboss/procedure-sdk";

export function toPublicRunResult<T extends KernelValue>(
  result: StoredRunResult<T>,
): RunResult<T> {
  return {
    run: result.run,
    data: result.data,
    dataRef: result.dataRef,
    display: result.display,
    displayRef: result.displayRef,
    streamRef: result.streamRef,
    memory: result.memory,
    pause: result.pause,
    pauseRef: result.pauseRef,
    summary: result.summary,
    dataShape: result.dataShape,
    explicitDataSchema: result.explicitDataSchema,
    rawRef: result.rawRef,
  };
}

export function runResultFromRunRecord(
  run: RunRecord,
  options: {
    tokenUsage?: AgentTokenUsage;
    defaultAgentSelection?: DownstreamAgentSelection;
  } = {},
): RunResult {
  return {
    run: run.run,
    summary: run.output.summary,
    display: run.output.display,
    memory: run.output.memory,
    dataRef: run.output.data !== undefined ? createRef(run.run, "output.data") : undefined,
    displayRef: run.output.display !== undefined ? createRef(run.run, "output.display") : undefined,
    streamRef: run.output.stream !== undefined ? createRef(run.run, "output.stream") : undefined,
    pause: run.output.pause,
    pauseRef: run.output.pause !== undefined ? createRef(run.run, "output.pause") : undefined,
    dataShape: run.output.data !== undefined ? inferDataShape(run.output.data) : undefined,
    explicitDataSchema: run.output.explicitDataSchema,
    tokenUsage: options.tokenUsage,
    defaultAgentSelection: options.defaultAgentSelection ?? run.meta.defaultAgentSelection,
  };
}
