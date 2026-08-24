import { describe, expect, it } from "vitest";
import { RESTART_BUTTON, updateDialogFor } from "./update-dialog";
import type { UpdateState, UpdateStatus } from "./updater";

function status(over: Partial<UpdateStatus> = {}): UpdateStatus {
  return {
    state: "not-available",
    autoUpdateEnabled: true,
    currentVersion: "1.0.107",
    updateVersion: null,
    lastCheckedAt: null,
    message: "Rome is up to date.",
    error: null,
    progress: null,
    ...over,
  };
}

// The whole point of the menu item: before this, a manual check that found
// nothing produced no dialog at all, so the item looked broken.
describe("updateDialogFor", () => {
  it("carries the manager's own sentence rather than composing a second one", () => {
    expect(updateDialogFor(status()).message).toBe("Rome is up to date.");
    expect(
      updateDialogFor(status({ state: "downloading", message: "Downloading Rome 1.0.108…" }))
        .message,
    ).toBe("Downloading Rome 1.0.108…");
  });

  it("puts the cause of a failure in the detail, where the message is vague", () => {
    const options = updateDialogFor(
      status({
        state: "error",
        message: "Could not check for updates.",
        error: "net::ERR_INTERNET_DISCONNECTED",
      }),
    );
    expect(options.type).toBe("warning");
    expect(options.detail).toBe("net::ERR_INTERNET_DISCONNECTED");
  });

  it("omits the detail when a failure carries no cause", () => {
    // `detail: null` would render the string "null" under the message.
    expect(updateDialogFor(status({ state: "error", error: null })).detail).toBeUndefined();
  });

  it("says something in every state a check can resolve into", () => {
    const states: UpdateState[] = [
      "idle",
      "checking",
      "available",
      "not-available",
      "downloading",
      "downloaded",
      "error",
    ];
    for (const state of states) {
      const options = updateDialogFor(status({ state, message: `state: ${state}` }));
      expect(options.message).toBe(`state: ${state}`);
      expect(options.buttons?.length).toBeGreaterThan(0);
    }
  });
});

// A check in this state returns early without doing anything, so a lone OK
// would answer "ready to install" with no way to install.
describe("updateDialogFor · downloaded", () => {
  const options = updateDialogFor(
    status({ state: "downloaded", message: "Rome 1.0.108 is ready to install." }),
  );

  it("offers the restart the automatic prompt offers", () => {
    expect(options.buttons).toEqual(["Restart Now", "Later"]);
    expect(options.defaultId).toBe(RESTART_BUTTON);
  });

  it("lets Escape mean Later", () => {
    expect(options.cancelId).toBe(1);
    expect(options.cancelId).not.toBe(RESTART_BUTTON);
  });
});
