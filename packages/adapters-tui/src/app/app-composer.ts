import type { PromptInput } from "@nanoboss/procedure-sdk";

import {
  type ComposerImageRecord,
  type ComposerState,
} from "./composer.ts";
import { buildPromptInputFromComposer } from "./composer-prompt-input.ts";

interface EditorTextCursorAdapter {
  setText(text: string): void;
  setCursor?(line: number, col: number): void;
}

export function buildPromptInputForSubmit(
  composerState: ComposerState,
  text: string,
  clearedSnapshot?: ComposerState,
): PromptInput {
  const promptInput = buildPromptInputFromComposer(composerState, text);
  if (promptInput.parts.some((part) => part.type === "image") || !clearedSnapshot) {
    return promptInput;
  }

  return buildPromptInputFromComposer(clearedSnapshot, text);
}

export function cloneComposerState(state: ComposerState): ComposerState {
  return {
    nextImageNumber: state.nextImageNumber,
    imagesByToken: new Map<string, ComposerImageRecord>(state.imagesByToken),
  };
}

export function applyEditorTextAndCursor(
  editor: EditorTextCursorAdapter,
  text: string,
  cursorIndex: number,
): void {
  editor.setText(text);
  const targetCursor = textIndexToCursor(text, cursorIndex);
  if (editor.setCursor) {
    editor.setCursor(targetCursor.line, targetCursor.col);
    return;
  }

  const editorImpl = editor as EditorTextCursorAdapter & {
    state?: { cursorLine: number; cursorCol: number };
    setCursorCol?: (col: number) => void;
  };
  if (!editorImpl.state) {
    return;
  }

  editorImpl.state.cursorLine = targetCursor.line;
  if (typeof editorImpl.setCursorCol === "function") {
    editorImpl.setCursorCol(targetCursor.col);
  } else {
    editorImpl.state.cursorCol = targetCursor.col;
  }
}

export function cursorToTextIndex(text: string, cursor: { line: number; col: number }): number {
  const lines = text.split("\n");
  let index = 0;

  for (let lineIndex = 0; lineIndex < cursor.line; lineIndex += 1) {
    index += (lines[lineIndex] ?? "").length + 1;
  }

  return index + cursor.col;
}

function textIndexToCursor(text: string, index: number): { line: number; col: number } {
  const clampedIndex = Math.max(0, Math.min(index, text.length));
  const before = text.slice(0, clampedIndex);
  const lines = before.split("\n");
  const line = Math.max(0, lines.length - 1);
  const col = (lines.at(-1) ?? "").length;
  return { line, col };
}
