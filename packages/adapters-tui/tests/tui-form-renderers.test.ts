import { describe, expect, test } from "bun:test";

import typia from "typia";
import { jsonType } from "@nanoboss/procedure-sdk";

import {
  getFormRenderer,
  registerFormRenderer,
  type FormRenderContext,
} from "../src/core/form-renderers.ts";
import {
  createInitialUiState,
  createNanobossTuiTheme,
} from "../src/index.ts";
// Side-effect import: populates the registry with core renderers that
// other test files (e.g. tui-app.test.ts) rely on when running in the
// shared bun test process.
import "../src/core/core-form-renderers.ts";

interface SamplePayload {
  title: string;
  reply: string;
}

const samplePayloadType = jsonType<SamplePayload>(
  typia.json.schema<SamplePayload>(),
  typia.createValidate<SamplePayload>(),
);

function stubComponent(label: string): { label: string; render(): string[]; invalidate(): void } {
  return {
    label,
    render() { return [label]; },
    invalidate() {},
  };
}

function buildCtx(
  payload: unknown,
  overrides: Partial<FormRenderContext<unknown>> = {},
): FormRenderContext<unknown> {
  return {
    payload,
    state: createInitialUiState({ cwd: "/repo", showToolCalls: true }),
    theme: createNanobossTuiTheme(),
    submit() {},
    cancel() {},
    editor: { setText() {}, getText: () => "" },
    ...overrides,
  };
}

describe("form renderer registry", () => {
  test("registerFormRenderer throws on duplicate formId", () => {
    registerFormRenderer<SamplePayload>({
      formId: "nb/test-form-duplicate@1",
      schema: samplePayloadType,
      render() { return stubComponent("first") as never; },
    });

    expect(() => {
      registerFormRenderer<SamplePayload>({
        formId: "nb/test-form-duplicate@1",
        schema: samplePayloadType,
        render() { return stubComponent("second") as never; },
      });
    }).toThrow(/already registered/);
  });

  test("getFormRenderer returns the registered renderer", () => {
    const renderer = {
      formId: "nb/test-form-get@1",
      schema: samplePayloadType,
      render(ctx: FormRenderContext<SamplePayload>) {
        return stubComponent(`label:${ctx.payload.title}`) as never;
      },
    };
    registerFormRenderer(renderer);

    expect(getFormRenderer("nb/test-form-get@1")).toBe(renderer as unknown as ReturnType<typeof getFormRenderer>);
    expect(getFormRenderer("nb/does-not-exist@1")).toBeUndefined();
  });

  test("payload failing typia validation is rejected at mount time", () => {
    registerFormRenderer<SamplePayload>({
      formId: "nb/test-form-validation@1",
      schema: samplePayloadType,
      render() { return stubComponent("ok") as never; },
    });

    const renderer = getFormRenderer("nb/test-form-validation@1");
    expect(renderer).toBeDefined();
    // Missing required `reply` field must fail schema.validate.
    expect(renderer!.schema.validate({ title: "hi" } as unknown)).toBe(false);
    expect(renderer!.schema.validate({ title: "hi", reply: "go" })).toBe(true);
  });

  test("ctx.submit routes a reply to the consumer-provided submit callback", () => {
    const submitted: string[] = [];
    const cancelled: number[] = [];
    registerFormRenderer<SamplePayload>({
      formId: "nb/test-form-submit@1",
      schema: samplePayloadType,
      render(ctx) {
        ctx.submit(ctx.payload.reply);
        return stubComponent("x") as never;
      },
    });
    const renderer = getFormRenderer("nb/test-form-submit@1")!;
    const ctx = buildCtx({ title: "hi", reply: "go-ahead" }, {
      submit: (reply) => { submitted.push(reply); },
      cancel: () => { cancelled.push(1); },
    });
    renderer.render(ctx);
    expect(submitted).toEqual(["go-ahead"]);
    expect(cancelled).toEqual([]);
  });

  test("ctx.cancel routes to the consumer-provided cancel callback without calling submit", () => {
    const submitted: string[] = [];
    const cancelled: number[] = [];
    registerFormRenderer<SamplePayload>({
      formId: "nb/test-form-cancel@1",
      schema: samplePayloadType,
      render(ctx) {
        ctx.cancel();
        return stubComponent("x") as never;
      },
    });
    const renderer = getFormRenderer("nb/test-form-cancel@1")!;
    const ctx = buildCtx({ title: "hi", reply: "go" }, {
      submit: (reply) => { submitted.push(reply); },
      cancel: () => { cancelled.push(1); },
    });
    renderer.render(ctx);
    expect(cancelled).toEqual([1]);
    expect(submitted).toEqual([]);
  });
});
