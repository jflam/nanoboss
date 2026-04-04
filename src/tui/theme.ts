import type { EditorTheme, MarkdownTheme, SelectListTheme } from "./pi-tui.ts";

export interface NanobossTuiTheme {
  text: (text: string) => string;
  accent: (text: string) => string;
  muted: (text: string) => string;
  dim: (text: string) => string;
  success: (text: string) => string;
  error: (text: string) => string;
  warning: (text: string) => string;
  bold: (text: string) => string;
  italic: (text: string) => string;
  underline: (text: string) => string;
  toolCardPendingBg: (text: string) => string;
  toolCardSuccessBg: (text: string) => string;
  toolCardErrorBg: (text: string) => string;
  toolCardBorder: (text: string) => string;
  toolCardTitle: (text: string) => string;
  toolCardMeta: (text: string) => string;
  toolCardBody: (text: string) => string;
  editor: EditorTheme;
  selectList: SelectListTheme;
  markdown: MarkdownTheme;
}

function style(text: string, codes: number[], resetCodes: number[]): string {
  if (text.length === 0) {
    return text;
  }

  return `\u001b[${codes.join(";")}m${text}\u001b[${resetCodes.join(";")}m`;
}

function fgStyle(text: string, ...codes: number[]): string {
  return style(text, codes, [39]);
}

function bgStyle(text: string, ...codes: number[]): string {
  return style(text, codes, [49]);
}

function attrStyle(text: string, code: number, resetCode: number): string {
  return style(text, [code], [resetCode]);
}

export function createNanobossTuiTheme(): NanobossTuiTheme {
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
  const toolCardPendingBg = (value: string) => bgStyle(value, 48, 5, 236);
  const toolCardSuccessBg = (value: string) => bgStyle(value, 48, 5, 22);
  const toolCardErrorBg = (value: string) => bgStyle(value, 48, 5, 52);
  const toolCardBorder = muted;
  const toolCardTitle = bold;
  const toolCardMeta = dim;
  const toolCardBody = text;

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
    editor: {
      borderColor: accent,
      selectList,
    },
    selectList,
    markdown,
  };
}
