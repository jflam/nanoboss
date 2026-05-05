import type { UiState } from "../state/state.ts";

type FrontendContinuation = NonNullable<UiState["pendingContinuation"]>;

export interface FrontendContinuationWithFormId {
  procedure: string;
  question: string;
  formId: string;
  formPayload: unknown;
  inputHint?: string;
  suggestedReplies?: readonly string[];
}

export function getFormContinuation(
  continuation: FrontendContinuation | undefined,
): FrontendContinuationWithFormId | undefined {
  if (!continuation) {
    return undefined;
  }
  // Procedures that need an inline continuation form emit
  // `continuation.form` directly via the form-renderer registry.
  const form = (continuation as { form?: { formId?: unknown; payload?: unknown } }).form;
  if (!form || typeof form !== "object" || typeof form.formId !== "string") {
    return undefined;
  }
  return {
    procedure: continuation.procedure,
    question: continuation.question,
    formId: form.formId,
    formPayload: form.payload,
    inputHint: continuation.inputHint,
    suggestedReplies: continuation.suggestedReplies,
  };
}

export function buildContinuationFormSignature(
  continuation: FrontendContinuationWithFormId,
): string {
  return JSON.stringify({
    procedure: continuation.procedure,
    question: continuation.question,
    inputHint: continuation.inputHint,
    suggestedReplies: continuation.suggestedReplies,
    formId: continuation.formId,
    payload: continuation.formPayload,
  });
}
