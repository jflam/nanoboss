import type {
  KernelValue,
  Ref,
  RunRef,
} from "@nanoboss/procedure-sdk";
import { publicKernelValueFromStored, type SessionStore } from "@nanoboss/store";

export function resolveNamedRefs(
  store: SessionStore,
  refs: Record<string, RunRef | Ref> | undefined,
): Record<string, unknown> | undefined {
  if (!refs || Object.keys(refs).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(refs).map(([name, ref]) => [
      name,
      isRef(ref)
        ? publicKernelValueFromStored(store.readRef(ref) as KernelValue)
        : store.getRun(ref),
    ]),
  );
}

function isRef(value: RunRef | Ref): value is Ref {
  return "path" in value;
}
