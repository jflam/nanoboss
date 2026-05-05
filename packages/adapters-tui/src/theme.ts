import type {
  NanobossTuiTheme as SdkNanobossTuiTheme,
  ToolCardThemeMode,
} from "@nanoboss/tui-extension-sdk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "./pi-tui.ts";
import { createToolCardCodeHighlighter } from "./theme-highlight.ts";
import {
  applyBoldRgb,
  applyRgb,
  getToolCardPalette,
} from "./theme-tool-card.ts";

export type { ToolCardThemeMode } from "@nanoboss/tui-extension-sdk";
export { getLanguageFromPath } from "./theme-languages.ts";

export type NanobossTuiTheme = SdkNanobossTuiTheme<
  EditorTheme,
  SelectListTheme,
  MarkdownTheme
>;

function style(text: string, codes: number[], resetCodes: number[]): string {
  if (text.length === 0) {
    return text;
  }

  return `\u001b[${codes.join(";")}m${text}\u001b[${resetCodes.join(";")}m`;
}

function fgStyle(text: string, ...codes: number[]): string {
  return style(text, codes, [39]);
}

function rgbFgStyle(text: string, red: number, green: number, blue: number): string {
  return style(text, [38, 2, red, green, blue], [39]);
}

function rgbBgStyle(text: string, red: number, green: number, blue: number): string {
  return style(text, [48, 2, red, green, blue], [49]);
}

function attrStyle(text: string, code: number, resetCode: number): string {
  return style(text, [code], [resetCode]);
}

export function createNanobossTuiTheme(initialToolCardMode: ToolCardThemeMode = "dark"): NanobossTuiTheme {
  let toolCardMode = initialToolCardMode;
  const toolCardPalette = () => getToolCardPalette(toolCardMode);
  const text = (value: string) => value;
  const accent = (value: string) => fgStyle(value, 36);
  const muted = (value: string) => fgStyle(value, 90);
  const dim = (value: string) => attrStyle(value, 2, 22);
  const success = (value: string) => fgStyle(value, 32);
  const error = (value: string) => fgStyle(value, 31);
  const warning = (value: string) => fgStyle(value, 33);
  const bold = (value: string) => attrStyle(value, 1, 22);
  const italic = (value: string) => attrStyle(value, 3, 23);
  const underline = (value: string) => attrStyle(value, 4, 24);
  const toolCardBackground = (value: string) => {
    const [red, green, blue] = toolCardPalette().background;
    return rgbBgStyle(value, red, green, blue);
  };
  const toolCardPendingBg = toolCardBackground;
  const toolCardSuccessBg = toolCardBackground;
  const toolCardErrorBg = toolCardBackground;
  const toolCardBorder = (value: string) => applyRgb(value, toolCardPalette().border);
  const toolCardTitle = (value: string) => applyBoldRgb(value, toolCardPalette().title);
  const toolCardMeta = (value: string) => applyRgb(value, toolCardPalette().meta);
  const toolCardBody = (value: string) => applyRgb(value, toolCardPalette().body);
  const toolCardAccent = (value: string) => applyRgb(value, toolCardPalette().accent);
  const toolCardWarning = (value: string) => applyRgb(value, toolCardPalette().warning);
  const toolCardSuccess = (value: string) => applyRgb(value, toolCardPalette().success);
  const toolCardError = (value: string) => applyRgb(value, toolCardPalette().error);
  const toolCardCode = (value: string) => applyRgb(value, toolCardPalette().code);
  const syntaxComment = (value: string) => applyRgb(value, toolCardPalette().syntaxComment);
  const syntaxKeyword = (value: string) => applyRgb(value, toolCardPalette().syntaxKeyword);
  const syntaxFunction = (value: string) => applyRgb(value, toolCardPalette().syntaxFunction);
  const syntaxVariable = (value: string) => applyRgb(value, toolCardPalette().syntaxVariable);
  const syntaxString = (value: string) => applyRgb(value, toolCardPalette().syntaxString);
  const syntaxNumber = (value: string) => applyRgb(value, toolCardPalette().syntaxNumber);
  const syntaxType = (value: string) => applyRgb(value, toolCardPalette().syntaxType);
  const syntaxOperator = (value: string) => applyRgb(value, toolCardPalette().syntaxOperator);
  const syntaxPunctuation = (value: string) => applyRgb(value, toolCardPalette().syntaxPunctuation);
  const highlightCode = createToolCardCodeHighlighter({
    toolCardCode,
    syntaxComment,
    syntaxKeyword,
    syntaxFunction,
    syntaxVariable,
    syntaxString,
    syntaxNumber,
    syntaxType,
    syntaxOperator,
    syntaxPunctuation,
  });

  const selectList: SelectListTheme = {
    selectedPrefix: (value) => style(value, [1, 36], [22, 39]),
    selectedText: (value) => style(value, [1, 36], [22, 39]),
    description: muted,
    scrollInfo: dim,
    noMatch: warning,
  };

  const markdown: MarkdownTheme = {
    heading: (value) => style(value, [1, 36], [22, 39]),
    link: (value) => style(value, [4, 36], [24, 39]),
    linkUrl: muted,
    code: (value) => warning(value),
    codeBlock: text,
    codeBlockBorder: muted,
    quote: muted,
    quoteBorder: muted,
    hr: muted,
    listBullet: accent,
    bold,
    italic,
    strikethrough: (value) => attrStyle(value, 9, 29),
    underline,
  };

  const getToolCardMode = (): ToolCardThemeMode => toolCardMode;
  const setToolCardMode = (mode: ToolCardThemeMode): void => {
    toolCardMode = mode;
  };

  return {
    text,
    accent,
    muted,
    dim,
    success,
    error,
    warning,
    bold,
    italic,
    underline,
    toolCardPendingBg,
    toolCardSuccessBg,
    toolCardErrorBg,
    toolCardBorder,
    toolCardTitle,
    toolCardMeta,
    toolCardBody,
    toolCardAccent,
    toolCardWarning,
    toolCardSuccess,
    toolCardError,
    highlightCode,
    getToolCardMode,
    setToolCardMode,
    editor: {
      borderColor: accent,
      selectList,
    },
    selectList,
    markdown,
  };
}
