import type { ClipboardImageProvider } from "../clipboard/provider.ts";
import {
  attachClipboardImage,
  findImageTokenRangeAtCursor,
  type ComposerState,
} from "./composer.ts";
import {
  applyEditorTextAndCursor,
  cursorToTextIndex,
} from "./app-composer.ts";

interface ClipboardEditor {
  setText(text: string): void;
  getText(): string;
  getCursor?(): { line: number; col: number };
  setCursor?(line: number, col: number): void;
  insertTextAtCursor?(text: string): void;
}

type ShowClipboardCard = (opts: {
  key: "local:clipboard";
  title: "Clipboard";
  markdown: string;
  severity: "info" | "warn";
}) => void;

export async function handleCtrlVImagePaste(params: {
  clipboardImageProvider: ClipboardImageProvider;
  composerState: ComposerState;
  editor: ClipboardEditor;
  showClipboardCard: ShowClipboardCard;
}): Promise<void> {
  const image = await params.clipboardImageProvider.readImage();
  if (!image) {
    params.showClipboardCard({
      key: "local:clipboard",
      title: "Clipboard",
      markdown: "No image was readable from the clipboard.",
      severity: "warn",
    });
    return;
  }

  const record = attachClipboardImage(params.composerState, image);
  if (params.editor.insertTextAtCursor) {
    params.editor.insertTextAtCursor(record.token);
  } else {
    params.editor.setText(`${params.editor.getText()}${record.token}`);
  }
  params.showClipboardCard({
    key: "local:clipboard",
    title: "Clipboard",
    markdown: `Attached clipboard image as \`${record.token}\`.`,
    severity: "info",
  });
}

export function handleImageTokenDeletion(params: {
  direction: "backspace" | "delete";
  composerState: ComposerState;
  editor: ClipboardEditor;
  showClipboardCard: ShowClipboardCard;
}): boolean {
  const text = params.editor.getText();
  if (text.length === 0 || params.composerState.imagesByToken.size === 0) {
    return false;
  }

  const cursor = params.editor.getCursor?.();
  if (!cursor) {
    return false;
  }

  const cursorIndex = cursorToTextIndex(text, cursor);
  const match = findImageTokenRangeAtCursor(params.composerState, text, cursorIndex, params.direction);
  if (!match) {
    return false;
  }

  params.composerState.imagesByToken.delete(match.token);
  const nextText = `${text.slice(0, match.start)}${text.slice(match.end)}`;
  applyEditorTextAndCursor(params.editor, nextText, match.start);
  params.showClipboardCard({
    key: "local:clipboard",
    title: "Clipboard",
    markdown: `Removed clipboard image \`${match.token}\`.`,
    severity: "info",
  });
  return true;
}
