import { highlight, supportsLanguage } from "cli-highlight";

type TextStyler = (text: string) => string;
type CliHighlightTheme = Record<string, TextStyler>;

export function createToolCardCodeHighlighter(styles: {
  toolCardCode: TextStyler;
  syntaxComment: TextStyler;
  syntaxKeyword: TextStyler;
  syntaxFunction: TextStyler;
  syntaxVariable: TextStyler;
  syntaxString: TextStyler;
  syntaxNumber: TextStyler;
  syntaxType: TextStyler;
  syntaxOperator: TextStyler;
  syntaxPunctuation: TextStyler;
}): (code: string, lang?: string) => string[] {
  const cliHighlightTheme: CliHighlightTheme = {
    keyword: styles.syntaxKeyword,
    built_in: styles.syntaxType,
    literal: styles.syntaxNumber,
    number: styles.syntaxNumber,
    string: styles.syntaxString,
    comment: styles.syntaxComment,
    function: styles.syntaxFunction,
    title: styles.syntaxFunction,
    class: styles.syntaxType,
    type: styles.syntaxType,
    attr: styles.syntaxVariable,
    variable: styles.syntaxVariable,
    params: styles.syntaxVariable,
    operator: styles.syntaxOperator,
    punctuation: styles.syntaxPunctuation,
  };

  return (code: string, lang?: string): string[] => {
    const validLanguage = lang && supportsLanguage(lang) ? lang : undefined;
    if (!validLanguage) {
      return code.split("\n").map((line) => styles.toolCardCode(line));
    }

    try {
      return highlight(code, {
        language: validLanguage,
        ignoreIllegals: true,
        theme: cliHighlightTheme,
      }).split("\n");
    } catch {
      return code.split("\n").map((line) => styles.toolCardCode(line));
    }
  };
}
