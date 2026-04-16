import { describe, expect, test } from "bun:test";

import { createNanobossTuiTheme } from "@nanoboss/adapters-tui";
import type { PromptInput } from "@nanoboss/contracts";
import { NanobossTuiApp } from "../../packages/adapters-tui/src/app.ts";
import { createInitialUiState, type UiState } from "../../packages/adapters-tui/src/state.ts";

class FakeEditor {
  text = "";
  cursorLine = 0;
  cursorCol = 0;
  disableSubmit = false;
  onSubmit?: (text: string) => void;
  onChange?: (text: string) => void;
  history: string[] = [];
  autocompleteProvider?: unknown;
  showingAutocomplete = false;

  addToHistory(text: string): void {
    this.history.push(text);
  }

  setText(text: string): void {
    this.text = text;
    const lines = text.split("\n");
    this.cursorLine = Math.max(0, lines.length - 1);
    this.cursorCol = (lines.at(-1) ?? "").length;
    this.onChange?.(text);
  }

  getText(): string {
    return this.text;
  }

  getCursor(): { line: number; col: number } {
    return {
      line: this.cursorLine,
      col: this.cursorCol,
    };
  }

  setCursor(line: number, col: number): void {
    this.cursorLine = line;
    this.cursorCol = col;
  }

  insertTextAtCursor(text: string): void {
    const lines = this.text.split("\n");
    const currentLine = lines[this.cursorLine] ?? "";
    lines[this.cursorLine] = `${currentLine.slice(0, this.cursorCol)}${text}${currentLine.slice(this.cursorCol)}`;
    this.text = lines.join("\n");
    this.cursorCol += text.length;
    this.onChange?.(this.text);
  }

  isShowingAutocomplete(): boolean {
    return this.showingAutocomplete;
  }

  setAutocompleteProvider(provider: unknown): void {
    this.autocompleteProvider = provider;
  }

  submit(): void {
    if (!this.disableSubmit) {
      const submitted = this.text;
      this.text = "";
      this.onChange?.("");
      this.onSubmit?.(submitted);
    }
  }
}

interface AutocompleteItemLike {
  value: string;
  label: string;
}

interface AutocompleteProviderLike {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<{
    items: AutocompleteItemLike[];
    prefix: string;
  } | null>;
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItemLike,
    prefix: string,
  ): {
    lines: string[];
    cursorLine: number;
    cursorCol: number;
  };
}

function createViewStub(onSetState?: () => void) {
  return {
    setState() {
      onSetState?.();
    },
    showComposer() {},
    showEditor() {},
  };
}

describe("NanobossTuiApp", () => {
  test("keeps pi-tui submit enabled for steering input while a run is active", () => {
    const editor = new FakeEditor();
    const handledSubmissions: PromptInput[] = [];
    let currentState: UiState = createInitialUiState({
      cwd: "/repo",
      showToolCalls: true,
    });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit(input) {
              if (typeof input !== "string") {
                handledSubmissions.push(input);
              }
            },
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => createViewStub(),
      },
    );

    editor.setText("hello");
    currentState = {
      ...currentState,
      inputDisabled: true,
    };
    capturedOnStateChange?.(currentState);
    expect(editor.disableSubmit).toBe(false);

    editor.setText("steer here");
    expect(editor.disableSubmit).toBe(false);

    editor.submit();
    expect(handledSubmissions).toEqual([
      {
        parts: [
          { type: "text", text: "steer here" },
        ],
      },
    ]);
  });

  test("keeps the leading slash when completing namespaced slash commands", async () => {
    const editor = new FakeEditor();
    let currentState: UiState = createInitialUiState({
      cwd: "/repo",
      showToolCalls: true,
    });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => createViewStub(),
      },
    );

    currentState = {
      ...currentState,
      availableCommands: ["/autoresearch/clear"],
    };
    capturedOnStateChange?.(currentState);

    const provider = editor.autocompleteProvider as AutocompleteProviderLike;
    const typedCommand = "/autoresearch/clear";
    const suggestions = await provider.getSuggestions(
      [typedCommand],
      0,
      typedCommand.length,
      { signal: new AbortController().signal },
    );
    expect(suggestions?.prefix).toBe(typedCommand);
    expect(suggestions?.items[0]).toEqual({
      value: "autoresearch/clear",
      label: "/autoresearch/clear",
    });
    if (!suggestions) {
      throw new Error("Expected autocomplete suggestions for slash command");
    }
    const [selectedItem] = suggestions.items;
    if (!selectedItem) {
      throw new Error("Expected slash command autocomplete item");
    }

    const completion = provider.applyCompletion(
      [typedCommand],
      0,
      typedCommand.length,
      selectedItem,
      suggestions.prefix,
    );
    expect(completion.lines).toEqual(["/autoresearch/clear "]);
  });

  test("pressing ctrl+o toggles expanded tool output", async () => {
    const editor = new FakeEditor();
    const toggles: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {
            toggles.push("toggle");
          },
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    const result = inputListener?.("\u000f");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(toggles).toEqual(["toggle"]);
  });

  test("pressing ctrl+g toggles simplify2 auto-approve", async () => {
    const editor = new FakeEditor();
    const toggles: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {
            toggles.push("toggle");
          },
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    const result = inputListener?.("\u0007");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(toggles).toEqual(["toggle"]);
  });

  test("pressing ctrl+v inserts an image token and submits structured prompt input", async () => {
    const editor = new FakeEditor();
    const submissions: PromptInput[] = [];
    const statuses: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createClipboardImageProvider: () => ({
          async readImage() {
            return {
              mimeType: "image/png",
              data: "YWJj",
              width: 1440,
              height: 900,
              byteLength: 620 * 1024,
            };
          },
        }),
        createController: () => ({
          getState: () => currentState,
          async handleSubmit(input) {
            if (typeof input !== "string") {
              submissions.push(input);
            }
          },
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus(text: string) {
            statuses.push(text);
          },
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("inspect ");
    const result = inputListener?.("\u0016");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(editor.getText()).toContain("[Image 1: PNG 1440x900 620KB]");
    expect(statuses).toEqual([
      "[clipboard] ctrl+v received",
      "[clipboard] attached [Image 1: PNG 1440x900 620KB]",
    ]);

    editor.submit();

    expect(submissions).toHaveLength(1);
    expect(submissions[0]?.parts[0]).toEqual({ type: "text", text: "inspect " });
    expect(submissions[0]?.parts[1]).toMatchObject({
      type: "image",
      token: "[Image 1: PNG 1440x900 620KB]",
      mimeType: "image/png",
      data: "YWJj",
      width: 1440,
      height: 900,
      byteLength: 620 * 1024,
    });
  });

  test("backspace on an image token removes the whole token and the attachment does not survive later submits", async () => {
    const editor = new FakeEditor();
    const submissions: PromptInput[] = [];
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createClipboardImageProvider: () => ({
          async readImage() {
            return {
              mimeType: "image/png",
              data: "YWJj",
              width: 1440,
              height: 900,
              byteLength: 620 * 1024,
            };
          },
        }),
        createController: () => ({
          getState: () => createInitialUiState({ cwd: "/repo", showToolCalls: true }),
          async handleSubmit(input) {
            if (typeof input !== "string") {
              submissions.push(input);
            }
          },
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("inspect ");
    inputListener?.("\u0016");
    await Promise.resolve();

    const token = "[Image 1: PNG 1440x900 620KB]";
    expect(editor.getText()).toBe(`inspect ${token}`);
    expect(editor.getCursor()).toEqual({ line: 0, col: `inspect ${token}`.length });

    const backspaceResult = inputListener?.("\u007f");
    await Promise.resolve();

    expect(backspaceResult).toEqual({ consume: true });
    expect(editor.getText()).toBe("inspect ");
    expect(editor.getCursor()).toEqual({ line: 0, col: "inspect ".length });

    editor.submit();
    editor.setText("second turn");
    editor.submit();

    expect(submissions).toHaveLength(2);
    expect(submissions[0]).toEqual({ parts: [{ type: "text", text: "inspect " }] });
    expect(submissions[1]).toEqual({ parts: [{ type: "text", text: "second turn" }] });
  });

  test("tab-queued prompts preserve attached images while a run is active", async () => {
    const editor = new FakeEditor();
    const queued: PromptInput[] = [];
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createClipboardImageProvider: () => ({
          async readImage() {
            return {
              mimeType: "image/png",
              data: "YWJj",
              width: 640,
              height: 480,
              byteLength: 2048,
            };
          },
        }),
        createController: () => ({
          getState: () => ({
            ...createInitialUiState({
              cwd: "/repo",
              showToolCalls: true,
            }),
            inputDisabled: true,
          }),
          async handleSubmit() {},
          async queuePrompt(input) {
            if (typeof input !== "string") {
              queued.push(input);
            }
          },
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("queue ");
    inputListener?.("\u0016");
    await Promise.resolve();

    const result = inputListener?.("\t");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(queued).toHaveLength(1);
    expect(queued[0]?.parts[0]).toEqual({ type: "text", text: "queue " });
    expect(queued[0]?.parts[1]).toMatchObject({
      type: "image",
      token: "[Image 1: PNG 640x480 2KB]",
      mimeType: "image/png",
      data: "YWJj",
      width: 640,
      height: 480,
      byteLength: 2048,
    });
  });

  test("opens the simplify2 continuation overlay and action 1 submits approval", async () => {
    const editor = new FakeEditor();
    const submitted: string[] = [];
    let currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let shownComposer: { handleInput?: (data: string) => void } | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit(input) {
              submitted.push(typeof input === "string"
                ? input
                : input.parts.map((part) => part.type === "text" ? part.text : part.token).join(""));
            },
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {},
          showComposer(component: unknown) {
            shownComposer = component as { handleInput?: (data: string) => void };
          },
          showEditor() {},
        }),
      },
    );

    currentState = {
      ...currentState,
      sessionId: "session-1",
      pendingContinuation: {
        procedure: "simplify2",
        question: "Approve this simplify2 slice?",
        ui: {
          kind: "simplify2_checkpoint",
          title: "Simplify2 checkpoint",
          actions: [
            { id: "approve", label: "Continue", reply: "approve it" },
            { id: "other", label: "Something Else" },
          ],
        },
      },
    };
    capturedOnStateChange?.(currentState);

    shownComposer?.handleInput?.("1");
    await Promise.resolve();

    expect(submitted).toEqual(["approve it"]);
  });

  test("opens the simplify2 focus picker overlay and n seeds a new focus reply", async () => {
    const editor = new FakeEditor();
    let currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let shownComposer: { handleInput?: (data: string) => void } | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => ({
          setState() {},
          showComposer(component: unknown) {
            shownComposer = component as { handleInput?: (data: string) => void };
          },
          showEditor() {},
        }),
      },
    );

    currentState = {
      ...currentState,
      sessionId: "session-1",
      pendingContinuation: {
        procedure: "simplify2",
        question: "Choose a focus",
        ui: {
          kind: "simplify2_focus_picker",
          title: "Simplify2 focuses",
          entries: [
            {
              id: "focus-1",
              title: "Session metadata",
              status: "active",
              updatedAt: "2026-04-10T10:00:00.000Z",
            },
          ],
          actions: [
            { id: "continue", label: "Continue" },
            { id: "archive", label: "Archive" },
            { id: "new", label: "New Focus" },
            { id: "cancel", label: "Cancel" },
          ],
        },
      },
    };
    capturedOnStateChange?.(currentState);

    shownComposer?.handleInput?.("n");

    expect(editor.getText()).toBe("new ");
  });

  test("pressing ctrl+c once clears the editor without exiting", async () => {
    const editor = new FakeEditor();
    const exits: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;
    const now = 1_000;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        now: () => now,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {
            exits.push("exit");
          },
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("draft");
    const result = inputListener?.("\u0003");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(editor.getText()).toBe("");
    expect(exits).toEqual([]);
  });

  test("pressing ctrl+c twice within the pi window exits", async () => {
    const editor = new FakeEditor();
    const exits: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;
    let now = 1_000;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        now: () => now,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {
            exits.push("exit");
          },
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("draft");
    expect(inputListener?.("\u0003")).toEqual({ consume: true });
    now += 250;
    expect(inputListener?.("\u0003")).toEqual({ consume: true });
    await Promise.resolve();

    expect(exits).toEqual(["exit"]);
  });

  test("ignores kitty ctrl+c release events so one press does not exit", async () => {
    const editor = new FakeEditor();
    const exits: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;
    const now = 1_000;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        now: () => now,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {
            exits.push("exit");
          },
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("draft");
    expect(inputListener?.("\u0003")).toEqual({ consume: true });
    expect(inputListener?.("\x1b[99;5:3u")).toBeUndefined();
    await Promise.resolve();

    expect(editor.getText()).toBe("");
    expect(exits).toEqual([]);
  });

  test("ignores duplicate ctrl+o input that arrives immediately", async () => {
    const editor = new FakeEditor();
    const toggles: string[] = [];
    const currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let inputListener: ((data: string) => unknown) | undefined;
    let now = 1_000;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        now: () => now,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt() {},
          async cancelActiveRun() {},
          toggleToolOutput() {
            toggles.push("toggle");
          },
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    const firstResult = inputListener?.("\u000f");
    now += 25;
    const secondResult = inputListener?.("\u000f");
    now += 200;
    const thirdResult = inputListener?.("\u000f");
    await Promise.resolve();

    expect(firstResult).toEqual({ consume: true });
    expect(secondResult).toEqual({ consume: true });
    expect(thirdResult).toEqual({ consume: true });
    expect(toggles).toEqual(["toggle", "toggle"]);
  });

  test("pressing escape while a run is active cancels the current run", async () => {
    const editor = new FakeEditor();
    const cancellations: string[] = [];
    const currentState: UiState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      inputDisabled: true,
    };
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {
              cancellations.push("cancel");
            },
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => createViewStub(),
      },
    );

    capturedOnStateChange?.(currentState);
    const result = inputListener?.("\u001b");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(cancellations).toEqual(["cancel"]);
  });

  test("pressing tab while a run is active queues the current input", async () => {
    const editor = new FakeEditor();
    const queued: PromptInput[] = [];
    const currentState: UiState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      inputDisabled: true,
    };
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt(input) {
            if (typeof input !== "string") {
              queued.push(input);
            }
          },
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("after this");
    const result = inputListener?.("\t");
    await Promise.resolve();

    expect(result).toEqual({ consume: true });
    expect(queued).toEqual([
      {
        parts: [
          { type: "text", text: "after this" },
        ],
      },
    ]);
  });

  test("pressing tab while a run is active does not queue when autocomplete is showing", async () => {
    const editor = new FakeEditor();
    const queued: PromptInput[] = [];
    const currentState: UiState = {
      ...createInitialUiState({ cwd: "/repo", showToolCalls: true }),
      inputDisabled: true,
    };
    let inputListener: ((data: string) => unknown) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener(listener) {
            inputListener = listener;
          },
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: () => ({
          getState: () => currentState,
          async handleSubmit() {},
          async queuePrompt(input) {
            if (typeof input !== "string") {
              queued.push(input);
            }
          },
          async cancelActiveRun() {},
          toggleToolOutput() {},
          toggleSimplify2AutoApprove() {},
          showStatus() {},
          requestExit() {},
          async run() {
            return undefined;
          },
          async stop() {},
        }),
        createView: () => createViewStub(),
      },
    );

    editor.setText("/aut");
    editor.showingAutocomplete = true;
    const result = inputListener?.("\t");
    await Promise.resolve();

    expect(result).toBeUndefined();
    expect(queued).toEqual([]);
  });

  test("refreshes the view while an active run is in progress so the timer can advance", async () => {
    const editor = new FakeEditor();
    let currentState: UiState = createInitialUiState({ cwd: "/repo", showToolCalls: true });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;
    let setStateCalls = 0;
    let requestRenderCalls = 0;
    const intervalCallbacks: Array<() => void> = [];
    const clearedIntervals: number[] = [];

    const app = new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {
            requestRenderCalls += 1;
          },
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              currentState = {
                ...currentState,
                inputDisabled: true,
                runStartedAtMs: 1_000,
              };
              capturedOnStateChange?.(currentState);
              intervalCallbacks[0]?.();
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => createViewStub(() => {
          setStateCalls += 1;
        }),
        setInterval(...args: Parameters<typeof globalThis.setInterval>) {
          const [handler] = args;
          if (typeof handler === "function") {
            const callback = handler as () => void;
            intervalCallbacks.push(() => {
              callback();
            });
          }
          return intervalCallbacks.length as unknown as ReturnType<typeof setInterval>;
        },
        clearInterval(handle) {
          clearedIntervals.push(Number(handle));
        },
      },
    );

    await app.run();

    expect(setStateCalls).toBe(2);
    expect(requestRenderCalls).toBe(4);
    expect(clearedIntervals).toEqual([1]);
  });

  test("applies local tool card theme changes to the shared theme instance", () => {
    const editor = new FakeEditor();
    const theme = createNanobossTuiTheme();
    let currentState: UiState = createInitialUiState({
      cwd: "/repo",
      showToolCalls: true,
    });
    let capturedOnStateChange: ((state: UiState) => void) | undefined;

    new NanobossTuiApp(
      {
        serverUrl: "http://localhost:3000",
        showToolCalls: true,
      },
      {
        createTheme: () => theme,
        createTerminal: () => ({
          setTitle() {},
          async drainInput() {},
        }),
        createTui: () => ({
          addInputListener() {},
          addChild() {},
          setFocus() {},
          start() {},
          requestRender() {},
          stop() {},
        }),
        createEditor: () => editor,
        createController: (_params, deps) => {
          capturedOnStateChange = deps.onStateChange;
          return {
            getState: () => currentState,
            async handleSubmit() {},
            async queuePrompt() {},
            async cancelActiveRun() {},
            toggleToolOutput() {},
            toggleSimplify2AutoApprove() {},
            showStatus() {},
            requestExit() {},
            async run() {
              return undefined;
            },
            async stop() {},
          };
        },
        createView: () => createViewStub(),
      },
    );

    expect(theme.getToolCardMode()).toBe("dark");

    currentState = {
      ...currentState,
      toolCardThemeMode: "light",
    };
    capturedOnStateChange?.(currentState);

    expect(theme.getToolCardMode()).toBe("light");
  });
});
