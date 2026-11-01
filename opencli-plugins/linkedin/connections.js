// Overrides clis/linkedin/connections.js from @yunfanye/opencli 1.8.8.
// Upstream stops at the first page shorter than it requested and returns bare rows,
// so a partial list looks exhausted. Keep the endpoint and row mapping in sync with upstream.
import {
  ArgumentError,
  AuthRequiredError,
  CommandExecutionError,
  EmptyResultError,
} from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { cleanText, unwrapEvaluateResult } from "./linkedin-helpers.mjs";

const LINKEDIN_DOMAIN = "www.linkedin.com";
const CONNECTIONS_PAGE_URL = "https://www.linkedin.com/mynetwork/invite-connect/connections/";
const CONNECTIONS_PATH = "/voyager/api/relationships/connections";
const PAGE_SIZE = 40;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 500;

// Runs in-page: fetches the legacy voyager connections REST endpoint with the
// session csrf token. Returns { authRequired } / { error } / { json }.
async function fetchConnections(url, csrf) {
  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: {
        "csrf-token": csrf,
        accept: "application/json",
        "x-restli-protocol-version": "2.0.0",
      },
    });
    if (res.status === 401 || res.status === 403) {
      return { authRequired: true, error: "HTTP " + res.status };
    }
    if (!res.ok) return { error: "HTTP " + res.status };
    const contentType = res.headers?.get?.("content-type") || "";
    if (/\btext\/html\b/i.test(contentType)) {
      return { authRequired: true, error: "HTML auth/checkpoint response" };
    }
    try {
      return { json: await res.json() };
    } catch {
      return { error: "response was not valid JSON" };
    }
  } catch (e) {
    return { error: "fetch failed: " + ((e && e.message) || String(e)) };
  }
}

function buildAuthProbeScript() {
  return String.raw`(() => {
    const text = [
      window.location.href || '',
      document.title || '',
      document.body ? (document.body.innerText || '').slice(0, 4000) : '',
    ].join('\n');
    return /linkedin\.com\/(?:login|checkpoint|authwall|uas)/i.test(text)
      || /\b(sign in|log in|join linkedin|captcha|verification required)\b/i.test(text)
      || /(请登录|登录领英|安全验证)/.test(text);
  })()`;
}

function parseIntegerArg(value, name, fallback, min, max) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ArgumentError(`--${name} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

async function readCsrf(page) {
  let cookies;
  try {
    cookies = await page.getCookies({ url: "https://www.linkedin.com" });
  } catch (error) {
    throw new CommandExecutionError(`LinkedIn cookie lookup failed: ${error?.message || error}`);
  }
  if (!Array.isArray(cookies)) {
    throw new CommandExecutionError("LinkedIn cookie lookup returned malformed payload");
  }
  const jsession = cookies.find((cookie) => cookie.name === "JSESSIONID")?.value;
  if (!jsession) {
    throw new AuthRequiredError(
      LINKEDIN_DOMAIN,
      "linkedin connections requires an active signed-in LinkedIn browser session.",
    );
  }
  return jsession.replace(/^"|"$/g, "");
}

function optionalText(value, field) {
  if (value == null) return "";
  if (typeof value !== "string") {
    throw new CommandExecutionError(`LinkedIn connection miniProfile field ${field} was malformed`);
  }
  return cleanText(value);
}

function mapConnection(element) {
  const mini = element && element.miniProfile;
  if (!mini || typeof mini !== "object") {
    throw new CommandExecutionError(
      "LinkedIn connections returned an element without a miniProfile",
    );
  }
  const publicId = optionalText(mini.publicIdentifier, "publicIdentifier");
  if (!publicId || /[\s/?#]/.test(publicId)) {
    throw new CommandExecutionError(
      "LinkedIn connection element missing a stable public identifier",
    );
  }
  const name =
    cleanText(
      [optionalText(mini.firstName, "firstName"), optionalText(mini.lastName, "lastName")]
        .filter(Boolean)
        .join(" "),
    ) || publicId;
  return {
    name,
    occupation: optionalText(mini.occupation, "occupation"),
    public_id: publicId,
    connected_at: Number.isFinite(element.createdAt) ? element.createdAt : 0,
    url: `https://www.linkedin.com/in/${encodeURIComponent(publicId)}`,
  };
}

// Returns LinkedIn's reported connection count, or null when the response does
// not carry one. A malformed total is treated as absent rather than trusted.
function readReportedTotal(json) {
  const total = json?.paging?.total;
  return Number.isInteger(total) && total >= 0 ? total : null;
}

/**
 * Pages through the connections endpoint from `offset` until `limit` unique
 * rows are collected or LinkedIn signals the end. Returns the rows and their coverage:
 * - `complete`: LinkedIn returned an empty page, or the next offset reached its reported total.
 * - `limit`: `limit` rows were collected and more connections remain or may remain.
 * - `partial`: LinkedIn stopped returning connections before its reported total,
 *   or the request budget ran out. Retrying from `next_offset` may return more.
 * `next_offset` is null only for `complete`.
 * Throws on auth walls and malformed or failed responses, never returning the accumulated subset.
 */
async function collectConnections(page, csrf, { limit, offset }) {
  const rows = [];
  const seen = new Set();
  let start = offset;
  let total = null;
  let coverage = null;
  // A short or overlapping page still advances `start`, so the budget only
  // binds when LinkedIn returns pages far smaller than requested.
  const maxRequests = Math.ceil(limit / PAGE_SIZE) * 2 + 2;

  for (let request = 0; request < maxRequests && coverage === null; request += 1) {
    const count = Math.min(PAGE_SIZE, limit - rows.length);
    const url = `${CONNECTIONS_PATH}?start=${start}&count=${count}`;
    const fetched = unwrapEvaluateResult(
      await page.evaluate(
        `(${fetchConnections.toString()})(${JSON.stringify(url)}, ${JSON.stringify(csrf)})`,
      ),
    );
    if (fetched && fetched.authRequired) {
      throw new AuthRequiredError(
        LINKEDIN_DOMAIN,
        "LinkedIn connections API authentication failed: " + fetched.error,
      );
    }
    if (!fetched || fetched.error || !fetched.json) {
      throw new CommandExecutionError(
        "LinkedIn connections API returned an unexpected response: " +
          ((fetched && fetched.error) || "no data"),
      );
    }
    const elements = fetched.json.elements;
    if (!Array.isArray(elements)) {
      throw new CommandExecutionError(
        "LinkedIn connections API returned a malformed payload: missing elements array",
      );
    }
    total = readReportedTotal(fetched.json) ?? total;

    if (elements.length === 0) {
      coverage = total !== null && start < total ? "partial" : "complete";
      break;
    }

    // LinkedIn can return fewer entries than requested while more remain, so a
    // short page is not the end. Advancing by the returned length rather than
    // `count` never skips an entry if LinkedIn left one out of the window, and
    // the overlap that can cause is removed by public_id.
    let consumed = 0;
    for (const element of elements) {
      consumed += 1;
      const row = mapConnection(element);
      if (seen.has(row.public_id)) continue;
      seen.add(row.public_id);
      rows.push(row);
      if (rows.length >= limit) break;
    }
    start += consumed;

    if (total !== null && start >= total) coverage = "complete";
    else if (rows.length >= limit) coverage = "limit";
  }
  coverage ??= "partial";

  return { rows, total, coverage, nextOffset: coverage === "complete" ? null : start };
}

function coverageNotice({ rows, total, coverage, nextOffset }) {
  const of = total === null ? "" : ` of ${total} reported`;
  const reason =
    coverage === "limit"
      ? "--limit reached"
      : "LinkedIn stopped returning connections before the end";
  return (
    `linkedin connections: returned ${rows.length}${of} connections (coverage=${coverage}: ${reason}). ` +
    `Continue with --offset ${nextOffset}.\n`
  );
}

cli({
  site: "linkedin",
  name: "connections",
  access: "read",
  description:
    "List your LinkedIn first-degree connections in LinkedIn API order, with coverage metadata on every row",
  example: "opencli linkedin connections --limit 500 -f json",
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "limit",
      type: "int",
      default: DEFAULT_LIMIT,
      help: `Number of connections to return (1-${MAX_LIMIT})`,
    },
    {
      name: "offset",
      type: "int",
      default: 0,
      help: "Position in LinkedIn's connection list to start from; pass a previous row's next_offset to continue",
    },
  ],
  columns: [
    "rank",
    "name",
    "occupation",
    "public_id",
    "connected_at",
    "url",
    "total",
    "coverage",
    "next_offset",
  ],
  func: async (page, kwargs) => {
    const limit = parseIntegerArg(kwargs.limit, "limit", DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = parseIntegerArg(kwargs.offset, "offset", 0, 0, Number.MAX_SAFE_INTEGER);
    await page.goto(CONNECTIONS_PAGE_URL);
    await page.wait(2);
    if (unwrapEvaluateResult(await page.evaluate(buildAuthProbeScript()))) {
      throw new AuthRequiredError(
        LINKEDIN_DOMAIN,
        "linkedin connections requires an active signed-in LinkedIn browser session.",
      );
    }
    const csrf = await readCsrf(page);
    const result = await collectConnections(page, csrf, { limit, offset });
    if (result.rows.length === 0) {
      if (result.total !== null && result.total > offset) {
        throw new CommandExecutionError(
          `LinkedIn reported ${result.total} connections but returned none from offset ${offset}`,
        );
      }
      throw new EmptyResultError("linkedin connections", "No LinkedIn connections were found.");
    }
    if (result.coverage !== "complete") process.stderr.write(coverageNotice(result));
    return result.rows.map((row, index) => ({
      rank: index + 1,
      ...row,
      total: result.total,
      coverage: result.coverage,
      next_offset: result.nextOffset,
    }));
  },
});

export const __test__ = { fetchConnections, mapConnection, PAGE_SIZE };
