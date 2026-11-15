import { describe, expect, it, rs } from "@rstest/core";
import { createStore } from "zustand/vanilla";
import { createBehaviorScope } from "./behavior";
import { fakePage } from "./fakes";
import { createFieldPresence } from "./field-presence";

function setup() {
  const scope = createBehaviorScope(createStore(() => ({})));
  const { page, hide, listeners } = fakePage();
  const hidden = rs.fn();
  const left = rs.fn();
  const presence = createFieldPresence(scope.context, { page, hidden, left });
  return { presence, hide, listeners, hidden, left, destroy: scope.destroy };
}

describe("field presence", () => {
  it("says the field left with the page each time the page goes away", () => {
    const { hide, left } = setup();
    hide();
    expect(left).toHaveBeenCalledWith("page-reloaded");
    // Restored from the back/forward cache, then hidden again.
    hide();
    expect(left).toHaveBeenCalledTimes(2);
  });

  it("says the field left the chat when it is destroyed, and stops watching the page", () => {
    const { left, listeners, destroy } = setup();
    destroy();
    expect(left).toHaveBeenCalledExactlyOnceWith("left-chat");
    expect(listeners.size).toBe(0);
  });

  it("says the field is hidden when it stops showing", () => {
    const { presence, hidden } = setup();
    presence.shown(true);
    expect(hidden).not.toHaveBeenCalled();
    presence.shown(false);
    expect(hidden).toHaveBeenCalledOnce();
  });
});
