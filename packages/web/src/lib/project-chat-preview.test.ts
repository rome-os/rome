import { describe, expect, it } from "@rstest/core";
import { buildProjectChatPreview } from "./project-chat-preview";

describe("buildProjectChatPreview", () => {
  it("uses the last assistant snippet when there is no search query", () => {
    expect(
      buildProjectChatPreview({
        query: "",
        searchText: "older user request hidden in full history",
        snippet: "Latest assistant response",
      }),
    ).toBe("Latest assistant response");
  });

  it("shows the matching chat history context when search text matches outside the snippet", () => {
    const preview = buildProjectChatPreview({
      maxLength: 48,
      query: "database lock",
      searchText:
        "Please review dashboard performance. The important issue is database lock contention under load. Later response text.",
      snippet: "Latest assistant response",
    });

    expect(preview).toContain("database lock");
    expect(preview).toContain("contention");
    expect(preview).not.toBe("Latest assistant response");
  });

  it("falls back to the snippet when the query only matches the title", () => {
    expect(
      buildProjectChatPreview({
        query: "roadmap",
        searchText: "The chat body does not contain that word.",
        snippet: "Latest assistant response",
      }),
    ).toBe("Latest assistant response");
  });
});
