import { describe, expect, it } from "@rstest/core";
import {
  type ChatPrivacyRow,
  canOpen,
  forkTriggerKind,
  PRIVATE_FORK_TRIGGER_KIND,
} from "./privacy.js";

const VISITOR = "visitor:a";

describe("chat privacy, read off the chat's own row", () => {
  it("opens a Concierge chat, a task chat and a private fork only for their owner", () => {
    const rows: ChatPrivacyRow[] = [
      { id: "topic", agentName: "core:concierge", ownerKey: VISITOR },
      { id: "task", triggerKind: "concierge", ownerKey: VISITOR },
      { id: "branch", triggerKind: PRIVATE_FORK_TRIGGER_KIND, ownerKey: VISITOR },
    ];
    for (const row of rows) {
      expect(canOpen(row, VISITOR)).toBe(true);
      expect(canOpen(row, "guardian")).toBe(false);
      expect(canOpen(row, null)).toBe(false);
    }
    // The guardian's main chat records no owner, and is the guardian's.
    expect(canOpen({ id: "concierge", agentName: "core:concierge" }, "guardian")).toBe(true);
    expect(canOpen({ id: "concierge", agentName: "core:concierge" }, VISITOR)).toBe(false);
  });

  it("opens an ordinary chat and an ordinary fork for everyone", () => {
    expect(canOpen({ id: "plain", ownerKey: "guardian" }, VISITOR)).toBe(true);
    expect(canOpen({ id: "branch", triggerKind: "fork", ownerKey: "guardian" }, null)).toBe(true);
  });

  it("makes a fork private when its parent is, and open when it is not", () => {
    expect(forkTriggerKind({ id: "task", triggerKind: "concierge", ownerKey: VISITOR })).toBe(
      PRIVATE_FORK_TRIGGER_KIND,
    );
    expect(
      forkTriggerKind({ id: "branch", triggerKind: PRIVATE_FORK_TRIGGER_KIND, ownerKey: VISITOR }),
    ).toBe(PRIVATE_FORK_TRIGGER_KIND);
    expect(forkTriggerKind({ id: "plain", ownerKey: "guardian" })).toBe("fork");
    expect(forkTriggerKind(null)).toBe("fork");
  });
});
