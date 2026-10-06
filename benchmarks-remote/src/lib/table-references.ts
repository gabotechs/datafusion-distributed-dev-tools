// Keywords that can follow a table reference in a FROM clause, so they are
// never mistaken for the table's alias.
const NON_ALIAS_KEYWORDS = new Set([
  "anti",
  "any",
  "array",
  "asof",
  "cross",
  "except",
  "final",
  "format",
  "full",
  "global",
  "group",
  "having",
  "inner",
  "intersect",
  "join",
  "left",
  "limit",
  "natural",
  "on",
  "order",
  "outer",
  "paste",
  "prewhere",
  "qualify",
  "right",
  "sample",
  "semi",
  "settings",
  "union",
  "using",
  "where",
  "window",
]);

// Keywords that end the FROM clause of the current query level.
const FROM_CLAUSE_END_KEYWORDS = new Set([
  "except",
  "format",
  "group",
  "having",
  "intersect",
  "limit",
  "order",
  "prewhere",
  "qualify",
  "select",
  "settings",
  "union",
  "where",
  "window",
]);

interface Token {
  text: string;
  start: number;
  end: number;
}

const TOKEN_PATTERN =
  /\s+|--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`\\]|\\.)*`|[A-Za-z_][A-Za-z0-9_]*|\d+(?:\.\d*)?|./gy;

function significantTokens(sql: string): Token[] {
  const tokens: Token[] = [];
  TOKEN_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_PATTERN.exec(sql)) !== null) {
    const text = match[0];
    if (/^\s/.test(text) || text.startsWith("--") || text.startsWith("/*")) {
      continue;
    }
    tokens.push({ text, start: match.index, end: TOKEN_PATTERN.lastIndex });
  }
  return tokens;
}

function identifierName(text: string): string | undefined {
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    return text.toLowerCase();
  }
  if (/^["`].*["`]$/s.test(text)) {
    return text.slice(1, -1).toLowerCase();
  }
  return undefined;
}

/**
 * Replaces each table reference in a FROM clause with the given source,
 * keeping the table name as its alias so qualified column references resolve.
 */
export function replaceTableReferences(
  sql: string,
  sources: ReadonlyMap<string, string>,
): string {
  const tokens = significantTokens(sql);
  // One entry per parenthesis depth: whether the current query level is in a
  // FROM clause, and whether the next token is in table position.
  const levels = [{ inFrom: false, expectTable: false }];
  const replacements: { start: number; end: number; text: string }[] = [];

  tokens.forEach((token, index) => {
    const level = levels[levels.length - 1]!;
    const word = token.text.toLowerCase();
    if (token.text === "(") {
      level.expectTable = false;
      levels.push({ inFrom: false, expectTable: false });
      return;
    }
    if (token.text === ")") {
      if (levels.length > 1) levels.pop();
      return;
    }
    if (token.text === ",") {
      level.expectTable = level.inFrom;
      return;
    }
    if (word === "from") {
      level.inFrom = true;
      level.expectTable = true;
      return;
    }
    if (word === "join") {
      level.expectTable = level.inFrom;
      return;
    }
    if (FROM_CLAUSE_END_KEYWORDS.has(word)) {
      level.inFrom = false;
      level.expectTable = false;
      return;
    }
    if (!level.expectTable) return;
    level.expectTable = false;

    const name = identifierName(token.text);
    const source = name === undefined ? undefined : sources.get(name);
    if (source === undefined || tokens[index + 1]?.text === "(") return;

    const next = tokens[index + 1];
    const nextWord = next?.text.toLowerCase();
    const hasAlias =
      nextWord !== undefined &&
      (nextWord === "as" ||
        (identifierName(next!.text) !== undefined &&
          !NON_ALIAS_KEYWORDS.has(nextWord)));
    replacements.push({
      start: token.start,
      end: token.end,
      text: hasAlias ? source : `${source} AS ${token.text}`,
    });
  });

  let result = sql;
  for (const { start, end, text } of replacements.reverse()) {
    result = result.slice(0, start) + text + result.slice(end);
  }
  return result;
}
