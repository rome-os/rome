// Overrides clis/linkedin/people-search.js from @yunfanye/opencli 1.8.8.
// Keep the search URL, auth checks, and redirect handling in sync when upstream changes them.
import { ArgumentError, AuthRequiredError, CommandExecutionError } from "@jackwener/opencli/errors";
import { cli, Strategy } from "@jackwener/opencli/registry";
import { cleanText, unwrapEvaluateResult } from "./linkedin-helpers.mjs";
import {
  MAX_PEOPLE_SEARCH_LIMIT,
  buildPeopleSearchUrl,
  looksLinkedInAuthWall,
  parsePeopleSearchLimit,
  peopleSearchRows,
} from "./people-search-helpers.mjs";
import { readPeopleSearchPage } from "./people-search-page.mjs";

const LINKEDIN_DOMAIN = "www.linkedin.com";
const READ_SCRIPT = `(${readPeopleSearchPage.toString()})()`;

async function readPage(page) {
  try {
    return unwrapEvaluateResult(await page.evaluate(READ_SCRIPT));
  } catch (error) {
    throw new CommandExecutionError(
      `LinkedIn people search extraction failed: ${error?.message || error}`,
    );
  }
}

cli({
  site: "linkedin",
  name: "people-search",
  access: "read",
  description:
    "Search standard LinkedIn (not Sales Navigator) for people by keyword. Each invocation consumes against LinkedIn's monthly Commercial Use Limit on people search; throttle accordingly.",
  example: 'opencli linkedin people-search "site reliability engineer berlin" --limit 5 -f json',
  domain: LINKEDIN_DOMAIN,
  strategy: Strategy.COOKIE,
  browser: true,
  args: [
    {
      name: "keywords",
      type: "string",
      required: true,
      positional: true,
      help: 'People search keywords, e.g. "site reliability engineer berlin"',
    },
    {
      name: "limit",
      type: "int",
      default: 5,
      help: `Maximum people to return (1-${MAX_PEOPLE_SEARCH_LIMIT}); each query counts toward LinkedIn's monthly CUL`,
    },
  ],
  columns: ["rank", "name", "headline", "location", "profile_url"],
  func: async (page, args) => {
    if (!page) {
      throw new CommandExecutionError("Browser session required for linkedin people-search");
    }
    const keywords = cleanText(args.keywords);
    if (!keywords) throw new ArgumentError("--keywords is required");
    let limit;
    try {
      limit = parsePeopleSearchLimit(args.limit);
    } catch (error) {
      throw new ArgumentError(error.message);
    }
    const searchUrl = buildPeopleSearchUrl(keywords);

    try {
      await page.goto(searchUrl);
      await page.wait(6);
    } catch (error) {
      throw new CommandExecutionError(
        `LinkedIn people search navigation failed: ${error?.message || error}`,
      );
    }

    let cookies;
    try {
      cookies = await page.getCookies({ url: "https://www.linkedin.com" });
    } catch (error) {
      throw new CommandExecutionError(`LinkedIn cookie lookup failed: ${error?.message || error}`);
    }
    if (!Array.isArray(cookies)) {
      throw new CommandExecutionError("LinkedIn cookie lookup returned malformed payload");
    }
    if (!cookies.find((cookie) => cookie.name === "JSESSIONID")?.value) {
      throw new AuthRequiredError(
        LINKEDIN_DOMAIN,
        "LinkedIn JSESSIONID cookie not found. Please sign in to LinkedIn in the browser.",
      );
    }

    let result = await readPage(page);
    // Results can still be streaming in after the fixed wait. A second read of the same page
    // costs no extra search against the Commercial Use Limit.
    if (Array.isArray(result?.rows) && result.rows.length === 0 && !result.error) {
      await page.wait(3);
      result = await readPage(page);
    }
    if (result?.error) {
      if (looksLinkedInAuthWall(`${result.url || ""} ${result.error || ""}`)) {
        throw new AuthRequiredError(
          LINKEDIN_DOMAIN,
          "LinkedIn people search requires an active signed-in browser session.",
        );
      }
      // A redirect away from the search page usually means the account reached its
      // Commercial Use Limit or is gated.
      throw new CommandExecutionError(
        `LinkedIn redirected away from the search page (${result.error}). Likely Commercial Use Limit reached - the limit resets on the 1st of next month.`,
      );
    }
    return peopleSearchRows(result, { keywords, limit, searchUrl });
  },
});
