export const PRE_COMMIT_MARKER_PREFIX = "[[nanoboss-precommit]] ";

export type PreCommitPhaseName =
  | "lint"
  | "typecheck"
  | "typecheck:packages"
  | "knip"
  | "test:packages"
  | "test";
export type PreCommitPhaseStatus = "passed" | "failed" | "not_run";

export interface PreCommitPhaseResult {
  phase: PreCommitPhaseName;
  status: PreCommitPhaseStatus;
  exitCode?: number;
}

export type PreCommitMarkerEvent =
  | {
      type: "phase_start";
      phase: PreCommitPhaseName;
    }
  | {
      type: "phase_result";
      phase: PreCommitPhaseName;
      status: PreCommitPhaseStatus;
      exitCode?: number;
    }
  | {
      type: "run_result";
      phases: PreCommitPhaseResult[];
    };

export function extractPreCommitPhaseResults(output: string): PreCommitPhaseResult[] {
  for (const line of output.split(/\r?\n/).reverse()) {
    const marker = parsePreCommitMarkerLine(line);
    if (marker?.type === "run_result") {
      return marker.phases;
    }
  }

  return [];
}

export function parsePreCommitMarkerLine(line: string): PreCommitMarkerEvent | undefined {
  if (!line.startsWith(PRE_COMMIT_MARKER_PREFIX)) {
    return undefined;
  }

  return parsePreCommitMarkerPayload(line.slice(PRE_COMMIT_MARKER_PREFIX.length));
}

export function parsePreCommitMarkerPayload(payload: string): PreCommitMarkerEvent | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }

  const candidate = parsed as Record<string, unknown>;
  if (candidate.type === "phase_start" && isPreCommitPhaseName(candidate.phase)) {
    return {
      type: "phase_start",
      phase: candidate.phase,
    };
  }

  if (
    candidate.type === "phase_result"
    && isPreCommitPhaseName(candidate.phase)
    && isPreCommitPhaseStatus(candidate.status)
  ) {
    return {
      type: "phase_result",
      phase: candidate.phase,
      status: candidate.status,
      ...(typeof candidate.exitCode === "number" ? { exitCode: candidate.exitCode } : {}),
    };
  }

  if (candidate.type === "run_result" && Array.isArray(candidate.phases)) {
    const phases = candidate.phases.flatMap((phase) => normalizePreCommitPhaseResult(phase));
    if (phases.length === candidate.phases.length) {
      return {
        type: "run_result",
        phases,
      };
    }
  }

  return undefined;
}

export function stripPreCommitMarkers(output: string): string {
  return output
    .split(/\r?\n/)
    .filter((line) => !line.startsWith(PRE_COMMIT_MARKER_PREFIX))
    .join("\n");
}

function normalizePreCommitPhaseResult(value: unknown): PreCommitPhaseResult[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  const candidate = value as Record<string, unknown>;
  if (isPreCommitPhaseName(candidate.phase) && isPreCommitPhaseStatus(candidate.status)) {
    return [{
      phase: candidate.phase,
      status: candidate.status,
      ...(typeof candidate.exitCode === "number" ? { exitCode: candidate.exitCode } : {}),
    }];
  }

  return [];
}

function isPreCommitPhaseName(value: unknown): value is PreCommitPhaseName {
  return value === "lint"
    || value === "typecheck"
    || value === "typecheck:packages"
    || value === "knip"
    || value === "test:packages"
    || value === "test";
}

function isPreCommitPhaseStatus(value: unknown): value is PreCommitPhaseStatus {
  return value === "passed" || value === "failed" || value === "not_run";
}
