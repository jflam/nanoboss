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

function style(text: string, ...codes: number[]): string {
  if (text.length === 0) {
    return text;
  }

  return `\u001b[${codes.join(";")}m${text}\u001b[0m`;
}

export function createNanobossTuiTheme(): NanobossTuiTheme {
  const text = (value: string) => value;
  const accent = (value: string) => style(value, 36);
  const muted = (value: string) => style(value, 90);
  const dim = (value: string) => style(value, 2);
  const success = (value: string) => style(value, 32);
  const error = (value: string) => style(value, 31);
  const warning = (value: string) => style(value, 33);
  const bold = (value: string) => style(value, 1);
  const italic = (value: string) => style(value, 3);
  const underline = (value: string) => style(value, 4);
  const toolCardPendingBg = (value: string) => value;
  const toolCardSuccessBg = (value: string) => value;
  const toolCardErrorBg = (value: string) => value;
  const toolCardBorder = muted;
  const toolCardTitle = bold;
  const toolCardMeta = dim;
  const toolCardBody = text;

  const selectList: SelectListTheme = {
    selectedPrefix: (value) => style(value, 1, 36),
    selectedText: (value) => style(value, 1, 36),
    description: muted,
    scrollInfo: dim,
    noMatch: warning,
  };

  const markdown: MarkdownTheme = {
    heading: (value) => style(value, 1, 36),
    link: (value) => style(value, 4, 36),
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
    strikethrough: (value) => style(value, 9),
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
