// @rstest-environment jsdom
import { afterEach, describe, expect, it, rs } from "@rstest/core";
import {
  activateDraftOwner,
  activeDraftOwner,
  clearNewChatDrafts,
  consumeDraftIntent,
  emptyNewChatDraft,
  readNewChatDraft,
  restoreNewChatDraft,
  writeNewChatDraft,
} from "./new-chat-draft-storage";

afterEach(() => {
  rs.restoreAllMocks();
  sessionStorage.clear();
});
const A = "guardian:synthetic-A";
const B = "guardian:synthetic-B";
const raw = "  中文🙂\n第二行\n  ";
describe("new-chat draft storage boundary", () => {
  it("roundtrips exact text and serializable context, not Files/request identities", () => {
    activateDraftOwner(A);
    const value = {
      ...emptyNewChatDraft(),
      text: raw,
      projectPath: "/synthetic",
      personaId: "person",
      agentMention: { appId: "app", agentName: "agent", appLabel: "App" },
      skill: { name: "skill" },
      manual: ["personaId"] as const,
    };
    writeNewChatDraft(A, { ...value, manual: [...value.manual] });
    expect(readNewChatDraft(A)?.value).toEqual(value);
    const serialized = sessionStorage.getItem(
      "rome:new-chat-draft:draft:" + encodeURIComponent(A),
    )!;
    expect(serialized.includes("inputId")).toBe(false);
    expect(serialized.includes("uploads")).toBe(false);
  });
  it.each([
    "oops",
    "null",
    '{"version":2}',
    '{"version":1,"revision":1}',
    '{"version":1,"revision":"r","value":{"text":42}}',
  ])("ignores malformed/incompatible records: %s", (bad) => {
    activateDraftOwner(A);
    sessionStorage.setItem("rome:new-chat-draft:draft:" + encodeURIComponent(A), bad);
    expect(readNewChatDraft(A)).toBeNull();
  });
  it("uses CAS tombstones, not empty-text equality: B then deletion still defeats A restore", () => {
    activateDraftOwner(A);
    const cleared = writeNewChatDraft(A, emptyNewChatDraft())!;
    writeNewChatDraft(A, { ...emptyNewChatDraft(), text: "new B" });
    writeNewChatDraft(A, emptyNewChatDraft());
    expect(restoreNewChatDraft(A, cleared.revision, { ...emptyNewChatDraft(), text: raw })).toBe(
      false,
    );
    expect(readNewChatDraft(A)?.value.text).toBe("");
  });
  it("clear/logout and A->B->A remove content and block late writes, preserving unrelated keys", () => {
    sessionStorage.setItem("rome:pending-app-remix", "unrelated");
    activateDraftOwner(A);
    const sent = writeNewChatDraft(A, emptyNewChatDraft())!;
    activateDraftOwner(B);
    writeNewChatDraft(B, { ...emptyNewChatDraft(), text: "B" });
    activateDraftOwner(A);
    expect(readNewChatDraft(A)).toBeNull();
    expect(restoreNewChatDraft(A, sent.revision, { ...emptyNewChatDraft(), text: raw })).toBe(
      false,
    );
    clearNewChatDrafts();
    expect(activeDraftOwner()).toBeNull();
    expect(writeNewChatDraft(A, { ...emptyNewChatDraft(), text: "late" })).toBeNull();
    expect(sessionStorage.getItem("rome:pending-app-remix")).toBe("unrelated");
  });
  it("keeps only opaque consumed-intent receipts across reset and supports fresh keys", () => {
    expect(consumeDraftIntent("intent-A")).toBe(true);
    activateDraftOwner(A);
    clearNewChatDrafts();
    activateDraftOwner(B);
    expect(consumeDraftIntent("intent-A")).toBe(false);
    expect(consumeDraftIntent("intent-B")).toBe(true);
  });
  it("degrades safely when storage throws", () => {
    rs.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    rs.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    rs.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => activateDraftOwner(A)).not.toThrow();
    expect(readNewChatDraft(A)).toBeNull();
    expect(writeNewChatDraft(A, emptyNewChatDraft())).toBeNull();
    expect(() => clearNewChatDrafts()).not.toThrow();
  });
});
