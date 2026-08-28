import { describe, expect, it } from "@rstest/core";

import { selectSupportedTools } from "./connector-search/index.js";

/**
 * `selectSupportedTools` is the search-boundary gate that keeps tools from
 * toolkits Rome can't OAuth into out of what the agent ever sees. It's pure over
 * the ranked tool list, so these drive it with fixtures and assert the surviving
 * set — no Composio client needed.
 */
describe("selectSupportedTools", () => {
  const tool = (slug: string, toolkitSlug: string) => ({ slug, toolkitSlug });

  it("drops tools whose toolkit is outside the supported catalog", () => {
    const tools = [
      tool("GMAIL_SEND_EMAIL", "gmail"),
      tool("TWITTER_POST_TWEET", "twitter"),
      tool("SLACK_SEND_MESSAGE", "slack"),
    ];
    expect(selectSupportedTools(tools, 10).map((t) => t.toolkitSlug)).toEqual(["gmail", "slack"]);
  });

  it("keeps the ranked order and trims to the requested limit", () => {
    const tools = [tool("GMAIL_A", "gmail"), tool("SLACK_B", "slack"), tool("NOTION_C", "notion")];
    expect(selectSupportedTools(tools, 2).map((t) => t.slug)).toEqual(["GMAIL_A", "SLACK_B"]);
  });

  it("matches the catalog case-insensitively", () => {
    expect(selectSupportedTools([tool("SLACK_X", "Slack")], 10)).toHaveLength(1);
  });

  it("returns nothing when no candidate is in the catalog", () => {
    expect(selectSupportedTools([tool("TWITTER_X", "twitter")], 10)).toEqual([]);
  });
});
