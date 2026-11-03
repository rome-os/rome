// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  clearNewChatDraft,
  currentAuthEpoch,
  invalidateNewChatDrafts,
  loadNewChatDraft,
  saveNewChatDraft,
  type NewChatDraft,
} from "./new-chat-draft-storage";

const empty: NewChatDraft = {
  version: 1,
  text: "",
  projectPath: "default",
  agentMention: null,
  skill: null,
  personaId: "",
};
afterEach(() => {
  rs.restoreAllMocks();
  rs.unstubAllGlobals();
  sessionStorage.clear();
  localStorage.clear();
});

describe("new-chat draft storage", () => {
  it("round-trips raw text and context", () => {
    const draft: NewChatDraft = {
      ...empty,
      text: "  中文🙂\n  ",
      projectPath: "project",
      personaId: "person",
      agentMention: { appId: "app", agentName: "agent", appLabel: "App" },
      skill: { name: "skill", iconUrl: null },
    };
    saveNewChatDraft(draft);
    expect(loadNewChatDraft()).toEqual(draft);
    expect(JSON.parse(sessionStorage.getItem("rome:new-chat-draft")!)).toEqual({
      ...draft,
      authEpoch: "",
    });
  });
  it.each([
    "oops",
    "null",
    '{"version":2}',
    '{"version":1,"text":42}',
  ])("ignores invalid records: %s", (bad) => {
    sessionStorage.setItem("rome:new-chat-draft", bad);
    expect(loadNewChatDraft()).toBeNull();
  });
  it("removes an empty/default draft and leaves unrelated keys alone", () => {
    sessionStorage.setItem("unrelated", "keep");
    saveNewChatDraft({ ...empty, text: "draft" });
    saveNewChatDraft(empty);
    expect(sessionStorage.getItem("rome:new-chat-draft")).toBeNull();
    expect(sessionStorage.getItem("unrelated")).toBe("keep");
  });
  it("keeps context-only drafts", () => {
    saveNewChatDraft({ ...empty, skill: { name: "skill" } });
    expect(loadNewChatDraft()?.skill).toEqual({ name: "skill" });
  });
  it("accepts a missing epoch consistently until auth changes", () => {
    const draft = { ...empty, text: "legacy draft" };
    sessionStorage.setItem("rome:new-chat-draft", JSON.stringify(draft));
    expect(loadNewChatDraft()).toEqual(draft);
    localStorage.setItem("rome:auth-epoch", "signed-out");
    expect(loadNewChatDraft()).toBeNull();
    expect(sessionStorage.getItem("rome:new-chat-draft")).toBeNull();
  });

  it("stores the shared epoch and removes a draft when another tab changes it", () => {
    localStorage.setItem("rome:auth-epoch", "first-login");
    saveNewChatDraft({ ...empty, text: "private draft" });
    expect(JSON.parse(sessionStorage.getItem("rome:new-chat-draft")!).authEpoch).toBe(
      "first-login",
    );
    localStorage.setItem("rome:auth-epoch", "next-login");
    expect(loadNewChatDraft()).toBeNull();
    expect(sessionStorage.getItem("rome:new-chat-draft")).toBeNull();
    saveNewChatDraft({ ...empty, text: "new user's draft" });
    expect(loadNewChatDraft()?.text).toBe("new user's draft");
  });

  it("refuses writes from a captured epoch after another tab logs out", () => {
    const epoch = currentAuthEpoch();
    saveNewChatDraft({ ...empty, text: "private draft" }, epoch);
    localStorage.setItem("rome:auth-epoch", "other-tab-logout");
    saveNewChatDraft({ ...empty, text: "stale edit" }, epoch);
    expect(sessionStorage.getItem("rome:new-chat-draft")).toBeNull();
    expect(loadNewChatDraft()).toBeNull();
  });

  it("invalidates another tab's retained sessionStorage on its next load", () => {
    saveNewChatDraft({ ...empty, text: "tab A private draft" });
    const tabAStorage = sessionStorage;
    const removeInTabB = rs.fn();
    rs.stubGlobal("sessionStorage", { removeItem: removeInTabB });
    invalidateNewChatDrafts();
    expect(removeInTabB).toHaveBeenCalledWith("rome:new-chat-draft");
    expect(localStorage.getItem("rome:auth-epoch")).toBeTruthy();
    expect(tabAStorage.getItem("rome:new-chat-draft")).not.toBeNull();
    rs.stubGlobal("sessionStorage", tabAStorage);
    expect(loadNewChatDraft()).toBeNull();
    expect(tabAStorage.getItem("rome:new-chat-draft")).toBeNull();
  });

  it("does not restore or persist content when the shared epoch cannot be read", () => {
    saveNewChatDraft({ ...empty, text: "private draft" });
    rs.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadNewChatDraft()).toBeNull();
    expect(() => saveNewChatDraft({ ...empty, text: "local edit" })).not.toThrow();
    expect(sessionStorage.getItem("rome:new-chat-draft")).toBeNull();
  });

  it("tolerates disabled or full storage", () => {
    for (const method of ["getItem", "setItem", "removeItem"] as const)
      rs.spyOn(Storage.prototype, method).mockImplementation(() => {
        throw new Error("blocked");
      });
    expect(loadNewChatDraft()).toBeNull();
    expect(() => saveNewChatDraft({ ...empty, text: "local" })).not.toThrow();
    expect(() => saveNewChatDraft(empty)).not.toThrow();
    expect(() => clearNewChatDraft()).not.toThrow();
    expect(() => invalidateNewChatDrafts()).not.toThrow();
  });
});
