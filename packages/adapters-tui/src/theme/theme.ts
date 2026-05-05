import type {
  NanobossTuiTheme as SdkNanobossTuiTheme,
  ToolCardThemeMode,
} from "@nanoboss/tui-extension-sdk";
import type { EditorTheme, MarkdownTheme, SelectListTheme } from "../shared/pi-tui.ts";
import {
  rgbBgStyle,
} from "./theme-ansi.ts";
import { createToolCardCodeHighlighter } from "./theme-highlight.ts";
import {
  applyBoldRgb,
  applyRgb,
  getToolCardPalette,
} from "./theme-tool-card.ts";
import {
  createBaseTextStyles,
  createMarkdownTheme,
  createSelectListTheme,
} from "./theme-base.ts";

export type { ToolCardThemeMode } from "@nanoboss/tui-extension-sdk";
export { getLanguageFromPath } from "./theme-languages.ts";

export type NanobossTuiTheme = SdkNanobossTuiTheme<
  EditorTheme,
  SelectListTheme,
  MarkdownTheme
>;

export function createNanobossTuiTheme(initialToolCardMode: ToolCardThemeMode = "dark"): NanobossTuiTheme {
  let toolCardMode = initialToolCardMode;
  const toolCardPalette = () => getToolCardPalette(toolCardMode);
  const base = createBaseTextStyles();
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

  const selectList = createSelectListTheme(base);
  const markdown = createMarkdownTheme(base);

  const getToolCardMode = (): ToolCardThemeMode => toolCardMode;
  const setToolCardMode = (mode: ToolCardThemeMode): void => {
    toolCardMode = mode;
  };

  return {
    ...base,
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
      borderColor: base.accent,
      selectList,
    },
    selectList,
    markdown,
  };
}
