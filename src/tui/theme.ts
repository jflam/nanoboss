import { highlight, supportsLanguage } from "cli-highlight";

import type { EditorTheme, MarkdownTheme, SelectListTheme } from "./pi-tui.ts";

export type ToolCardThemeMode = "dark" | "light";

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
  toolCardAccent: (text: string) => string;
  toolCardWarning: (text: string) => string;
  toolCardSuccess: (text: string) => string;
  toolCardError: (text: string) => string;
  highlightCode: (code: string, lang?: string) => string[];
  getToolCardMode: () => ToolCardThemeMode;
  setToolCardMode: (mode: ToolCardThemeMode) => void;
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

function rgbFgStyle(text: string, red: number, green: number, blue: number): string {
  return style(text, [38, 2, red, green, blue], [39]);
}

function rgbBgStyle(text: string, red: number, green: number, blue: number): string {
  return style(text, [48, 2, red, green, blue], [49]);
}

function attrStyle(text: string, code: number, resetCode: number): string {
  return style(text, [code], [resetCode]);
}

type CliHighlightTheme = Record<string, (text: string) => string>;
type Rgb = readonly [number, number, number];

interface ToolCardPalette {
  background: Rgb;
  border: Rgb;
  title: Rgb;
  meta: Rgb;
  body: Rgb;
  accent: Rgb;
  warning: Rgb;
  success: Rgb;
  error: Rgb;
  code: Rgb;
  syntaxComment: Rgb;
  syntaxKeyword: Rgb;
  syntaxFunction: Rgb;
  syntaxVariable: Rgb;
  syntaxString: Rgb;
  syntaxNumber: Rgb;
  syntaxType: Rgb;
  syntaxOperator: Rgb;
  syntaxPunctuation: Rgb;
}

const TOOL_CARD_PALETTE_BY_MODE: Record<ToolCardThemeMode, ToolCardPalette> = {
  dark: {
    background: [32, 32, 32],
    border: [148, 163, 184],
    title: [248, 250, 252],
    meta: [148, 163, 184],
    body: [229, 231, 235],
    accent: [125, 211, 252],
    warning: [253, 186, 116],
    success: [74, 222, 128],
    error: [248, 113, 113],
    code: [229, 192, 123],
    syntaxComment: [106, 153, 85],
    syntaxKeyword: [86, 156, 214],
    syntaxFunction: [220, 220, 170],
    syntaxVariable: [156, 220, 254],
    syntaxString: [206, 145, 120],
    syntaxNumber: [181, 206, 168],
    syntaxType: [78, 201, 176],
    syntaxOperator: [212, 212, 212],
    syntaxPunctuation: [212, 212, 212],
  },
  light: {
    background: [245, 245, 246],
    border: [100, 116, 139],
    title: [15, 23, 42],
    meta: [71, 85, 105],
    body: [31, 41, 55],
    accent: [3, 105, 161],
    warning: [146, 64, 14],
    success: [22, 101, 52],
    error: [153, 27, 27],
    code: [120, 53, 15],
    syntaxComment: [71, 85, 105],
    syntaxKeyword: [29, 78, 216],
    syntaxFunction: [109, 40, 217],
    syntaxVariable: [14, 116, 144],
    syntaxString: [154, 52, 18],
    syntaxNumber: [21, 101, 192],
    syntaxType: [6, 95, 70],
    syntaxOperator: [55, 65, 81],
    syntaxPunctuation: [55, 65, 81],
  },
};

function applyRgb(text: string, rgb: Rgb): string {
  return rgbFgStyle(text, rgb[0], rgb[1], rgb[2]);
}

function applyBoldRgb(text: string, rgb: Rgb): string {
  return style(text, [1, 38, 2, rgb[0], rgb[1], rgb[2]], [22, 39]);
}

export function getLanguageFromPath(filePath: string): string | undefined {
  const ext = filePath.split(".").pop()?.toLowerCase();
  if (!ext) {
    return undefined;
  }

  const extToLang: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    kt: "kotlin",
    swift: "swift",
    c: "c",
    h: "c",
    cpp: "cpp",
    cc: "cpp",
    cxx: "cpp",
    hpp: "cpp",
    cs: "csharp",
    php: "php",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    fish: "fish",
    ps1: "powershell",
    sql: "sql",
    html: "html",
    htm: "html",
    css: "css",
    scss: "scss",
    sass: "sass",
    less: "less",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    xml: "xml",
    md: "markdown",
    markdown: "markdown",
    dockerfile: "dockerfile",
    makefile: "makefile",
    cmake: "cmake",
    lua: "lua",
    perl: "perl",
    r: "r",
    scala: "scala",
    clj: "clojure",
    ex: "elixir",
    exs: "elixir",
    erl: "erlang",
    hs: "haskell",
    ml: "ocaml",
    vim: "vim",
    graphql: "graphql",
    proto: "protobuf",
    tf: "hcl",
    hcl: "hcl",
  };

  return extToLang[ext];
}

export function createNanobossTuiTheme(initialToolCardMode: ToolCardThemeMode = "dark"): NanobossTuiTheme {
  let toolCardMode = initialToolCardMode;
  const toolCardPalette = (): ToolCardPalette => TOOL_CARD_PALETTE_BY_MODE[toolCardMode];
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
  const cliHighlightTheme: CliHighlightTheme = {
    keyword: syntaxKeyword,
    built_in: syntaxType,
    literal: syntaxNumber,
    number: syntaxNumber,
    string: syntaxString,
    comment: syntaxComment,
    function: syntaxFunction,
    title: syntaxFunction,
    class: syntaxType,
    type: syntaxType,
    attr: syntaxVariable,
    variable: syntaxVariable,
    params: syntaxVariable,
    operator: syntaxOperator,
    punctuation: syntaxPunctuation,
  };
  const highlightCode = (code: string, lang?: string): string[] => {
    const validLanguage = lang && supportsLanguage(lang) ? lang : undefined;
    if (!validLanguage) {
      return code.split("\n").map((line) => toolCardCode(line));
    }

    try {
      return highlight(code, {
        language: validLanguage,
        ignoreIllegals: true,
        theme: cliHighlightTheme,
      }).split("\n");
    } catch {
      return code.split("\n").map((line) => toolCardCode(line));
    }
  };

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
