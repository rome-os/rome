// Finding things in a catalog: the regex query an agent searches with, its
// ranking and its limit. Actions and skills share them.

const DEFAULT_SEARCH_LIMIT = 10;
export const MAX_SEARCH_LIMIT = 25;
export const SEARCH_LIMIT_DESCRIPTION =
  `Optional. Recommended: omit this parameter to use the default of ${DEFAULT_SEARCH_LIMIT}. ` +
  `If provided, use an integer from 1 to ${MAX_SEARCH_LIMIT}.`;

interface SearchMatcher {
  kind: "regex";
  matches(text: string): boolean;
  scoreName(text: string): number;
  scoreDescription(text: string): number;
}

export function normalizeSearchLimit(limit: number | undefined): number {
  if (typeof limit !== "number" || !Number.isFinite(limit)) {
    return DEFAULT_SEARCH_LIMIT;
  }
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_SEARCH_LIMIT);
}

function parseRegexQuery(queryText: string): RegExp | null {
  const trimmed = queryText.trim();
  if (!trimmed.startsWith("/") || trimmed.length < 2) {
    return null;
  }

  const lastSlash = trimmed.lastIndexOf("/");
  if (lastSlash <= 0) {
    return null;
  }

  const flags = trimmed.slice(lastSlash + 1);
  if (!/^[dgimsuvy]*$/.test(flags)) {
    return null;
  }

  try {
    return new RegExp(trimmed.slice(1, lastSlash), flags);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex query: ${message}`);
  }
}

function matchesRegex(regex: RegExp, text: string): boolean {
  regex.lastIndex = 0;
  return regex.test(text);
}

function compileSearchRegex(queryText: string): RegExp {
  const explicitRegex = parseRegexQuery(queryText);
  if (explicitRegex) {
    return explicitRegex;
  }

  try {
    return new RegExp(queryText, "i");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid regex query: ${message}`);
  }
}

export function createSearchMatcher(queryText: string): SearchMatcher | null {
  const trimmed = queryText.trim();
  if (!trimmed) {
    return null;
  }

  const regex = compileSearchRegex(trimmed);
  return {
    kind: "regex",
    matches: (text) => matchesRegex(regex, text),
    scoreName: (text) => (matchesRegex(regex, text) ? 5 : 0),
    scoreDescription: (text) => (matchesRegex(regex, text) ? 3 : 0),
  };
}
