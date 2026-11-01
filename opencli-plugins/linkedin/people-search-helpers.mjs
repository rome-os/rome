import { CommandExecutionError, EmptyResultError } from "@jackwener/opencli/errors";
import { canonicalizeLinkedInProfileUrl } from "./connect-receipt.mjs";
import { cleanText } from "./linkedin-helpers.mjs";

export const MAX_PEOPLE_SEARCH_LIMIT = 10;
const DEFAULT_LIMIT = 5;
const SEARCH_URL_BASE = "https://www.linkedin.com/search/results/people/";

export function parsePeopleSearchLimit(value) {
  if (value === undefined || value === null || value === "") return DEFAULT_LIMIT;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PEOPLE_SEARCH_LIMIT) {
    throw new Error(`--limit must be an integer between 1 and ${MAX_PEOPLE_SEARCH_LIMIT}`);
  }
  return limit;
}

export function buildPeopleSearchUrl(keywords) {
  return `${SEARCH_URL_BASE}?keywords=${encodeURIComponent(keywords)}`;
}

export function looksLinkedInAuthWall(value) {
  const text = cleanText(value).toLowerCase();
  if (!text) return false;
  return (
    /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(text) ||
    /\b(?:sign in|log in|join linkedin|captcha|verification required)\b/i.test(text) ||
    /(请登录|登录领英|安全验证)/.test(text)
  );
}

function parseCount(value, label) {
  const count = Number(value);
  if (!Number.isInteger(count) || count < 0) {
    throw new CommandExecutionError(
      `LinkedIn people search returned malformed extraction payload: invalid ${label}`,
    );
  }
  return count;
}

/**
 * Validates one page read and returns ranked rows, at most `limit` of them.
 *
 * Throws CommandExecutionError when profile links rendered but no result layout matched them, so
 * callers can tell an unsupported layout from a search with no results (EmptyResultError).
 */
export function peopleSearchRows(payload, { keywords, limit, searchUrl }) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.rows)) {
    throw new CommandExecutionError(
      "LinkedIn people search returned malformed extraction payload: missing rows array",
    );
  }
  const candidates = parseCount(payload.candidate_count, "candidate_count");
  const rows = payload.rows.map((row, index) => {
    if (!row || typeof row !== "object") {
      throw new CommandExecutionError(
        `LinkedIn people search returned malformed row at index ${index}`,
      );
    }
    const name = cleanText(row.name);
    const profileUrl = canonicalizeLinkedInProfileUrl(row.profile_url);
    if (!name || !profileUrl) {
      throw new CommandExecutionError(
        `LinkedIn people search returned row without stable profile identity at index ${index}`,
      );
    }
    return {
      name,
      headline: cleanText(row.headline),
      location: cleanText(row.location),
      profile_url: profileUrl,
    };
  });
  if (rows.length === 0 && candidates > 0) {
    throw new CommandExecutionError(
      `LinkedIn people search layout is not supported: the page rendered ${candidates} profile ` +
        "link(s), but none matched a search result, so no rows were returned.",
      "Do not infer anyone's identity from this search, and do not rerun people-search to retry: " +
        "each search counts toward LinkedIn's monthly Commercial Use Limit. To read the results " +
        `once, run \`opencli browser open "${searchUrl}"\` and then \`opencli browser get text main\` ` +
        "with the same --profile. Confirm a candidate with " +
        "`opencli linkedin profile-read --profile-url <profile-url>` before acting on it.",
    );
  }
  if (rows.length === 0) {
    throw new EmptyResultError(
      `linkedin people-search "${keywords}"`,
      "LinkedIn rendered no people results for these keywords.",
    );
  }
  return rows.slice(0, limit).map((row, index) => ({ rank: index + 1, ...row }));
}
