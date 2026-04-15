import type { Ref, RunRef } from "../core/types.ts";

interface CellRef {
  sessionId: string;
  cellId: string;
}

interface ValueRef {
  cell: CellRef;
  path: string;
}

export function createCellRef(sessionId: string, cellId: string): CellRef {
  return { sessionId, cellId };
}

export function createValueRef(cell: CellRef, path: string): ValueRef {
  return { cell, path };
}

export function runRefFromCellRef(cell: CellRef): RunRef {
  return {
    sessionId: cell.sessionId,
    runId: cell.cellId,
  };
}

export function cellRefFromRunRef(run: RunRef): CellRef {
  return {
    sessionId: run.sessionId,
    cellId: run.runId,
  };
}

export function refFromValueRef(valueRef: ValueRef): Ref {
  return {
    run: runRefFromCellRef(valueRef.cell),
    path: valueRef.path,
  };
}

export function valueRefFromRef(ref: Ref): ValueRef {
  return {
    cell: cellRefFromRunRef(ref.run),
    path: ref.path,
  };
}
