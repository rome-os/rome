import { describe, expect, it } from "@rstest/core";
import { DEFAULT_SETTINGS } from "../../db/repositories/settings.js";
import type { Brief } from "../../db/repositories/briefs.js";
import {
  buildPrompt,
  deliversToGuardian,
  previousDayBriefs,
  suggestionsSection,
  withoutSuggestions,
} from "./index.js";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-10-23T15:00:00Z");

function brief(
  kind: string,
  hoursAgo: number,
  content: string | null,
  status = "completed",
): Brief {
  return {
    id: `${kind}-${hoursAgo}`,
    kind,
    status,
    content,
    error: null,
    channel: "email",
    delivered: true,
    deliveryError: null,
    scoutResultCount: 0,
    startedAt: new Date(NOW.getTime() - hoursAgo * HOUR),
    finishedAt: null,
  };
}

describe("deliversToGuardian", () => {
  it("adds personal context only when the brief goes to the guardian", () => {
    const email = { ...DEFAULT_SETTINGS, channel: "email" };
    expect(deliversToGuardian({ ...email, emailTo: "guardian" }, true)).toBe(true);
    expect(deliversToGuardian({ ...email, emailTo: "" }, true)).toBe(true);
    expect(deliversToGuardian({ ...email, emailTo: "team@example.com" }, true)).toBe(false);
    expect(deliversToGuardian({ ...email, emailTo: "team@example.com" }, false)).toBe(true);
    const whatsapp = { ...DEFAULT_SETTINGS, channel: "whatsapp" };
    expect(deliversToGuardian({ ...whatsapp, whatsappThreadId: "" }, true)).toBe(true);
    expect(deliversToGuardian({ ...whatsapp, whatsappThreadId: "123@g.us" }, true)).toBe(false);
  });
});

describe("suggestionsSection", () => {
  it("reads the Try with Rome section wherever it sits", () => {
    expect(suggestionsSection("**Scouting**\nx\n\n**Try with Rome**\n- Track orders")).toBe(
      "- Track orders",
    );
    expect(suggestionsSection("**Try with Rome**\n- A\n\n**Calendar**\n- B")).toBe("- A");
    expect(suggestionsSection("**Summary**\nNothing")).toBeNull();
    expect(suggestionsSection(null)).toBeNull();
  });
});

describe("withoutSuggestions", () => {
  it("drops only the Try with Rome section", () => {
    expect(
      withoutSuggestions("**Summary**\nA\n\n**Try with Rome**\n- Idea\n\n**Calendar**\n- B"),
    ).toBe("**Summary**\nA\n\n**Calendar**\n- B");
    expect(withoutSuggestions("**Summary**\nA\n\n**Try with Rome**\n- Idea")).toBe(
      "**Summary**\nA",
    );
    expect(withoutSuggestions("**Summary**\nA")).toBe("**Summary**\nA");
  });
});

describe("previousDayBriefs", () => {
  it("keeps completed scheduled briefs from the past day, oldest first", () => {
    const recent = [
      brief("test", 1, "test run"),
      brief("evening", 13, "last night"),
      brief("morning", 24, "yesterday morning"),
      brief("morning", 20, null, "failed"),
      brief("evening", 37, "two nights ago"),
    ];
    expect(previousDayBriefs(recent, NOW).map((b) => b.content)).toEqual([
      "yesterday morning",
      "last night",
    ]);
  });
});

describe("buildPrompt", () => {
  it("passes the past day's briefs for continuity", () => {
    const previous = [
      brief("evening", 13, "**Action Items**\n- Reply to Sam\n\n**Try with Rome**\n- Idea"),
    ];
    const prompt = buildPrompt("morning", "UTC", [], { chats: "x", profile: null }, [], previous);
    expect(prompt).toContain("CONTINUITY");
    expect(prompt).toContain("### Evening brief — Friday 2:00 AM");
    expect(prompt).toContain("- Reply to Sam");

    const toOthers = buildPrompt("morning", "UTC", [], null, [], previous);
    expect(toOthers).toContain("- Reply to Sam");
    expect(toOthers).not.toContain("- Idea");

    expect(buildPrompt("morning", "UTC", [], null, [])).not.toContain("CONTINUITY");
  });

  it("notes unconnected sources only in the first brief", () => {
    const first = buildPrompt("morning", "UTC", [], null, [], [], true);
    expect(first).toContain("first brief");
    expect(first).toContain("'_Calendar not connected._'");

    const later = buildPrompt("morning", "UTC", [], null, []);
    expect(later).toContain("chosen not to connect them");
    expect(later).not.toContain("'_Calendar not connected._'");

    for (const prompt of [first, later]) {
      expect(prompt).toContain("not signed in");
      expect(prompt).toContain("never an Action Item");
    }
  });

  it("passes personal context only with the Try with Rome rules", () => {
    const context = { chats: 'Chat "Orders":\n- I sort these by hand', profile: "Name: Ada" };
    const prompt = buildPrompt("evening", "UTC", [], context, ["- Earlier idea"]);
    expect(prompt).toContain("I sort these by hand");
    expect(prompt).toContain("- Earlier idea");
    expect(prompt).toContain("under a **Try with Rome** header");
    expect(prompt).toContain("Be proactive.");
    expect(prompt).toContain("For a hobby:");
    expect(prompt).not.toContain("${");

    const without = buildPrompt("evening", "UTC", [], null, []);
    expect(without).not.toContain("TRY WITH ROME");
    expect(without).not.toContain("RECENT WEBCHAT MESSAGES");
  });
});
