import { checkWidgetUi } from "@rome-os/app-runtime";
import { describe, expect, it } from "@rstest/core";
import {
  connectAccountToolOutput,
  connectCardUiFromProps,
  parseConnectAccountInput,
} from "./connect-card.js";

describe("connect_account", () => {
  it("shows a card every reader can draw, which the agent waits on", () => {
    expect(connectAccountToolOutput("github", true)).toMatchObject({
      pendingInteraction: true,
      appId: "core",
      render: { componentId: "connect-card", props: { kind: "github" }, builtin: true },
    });
    const ui = connectCardUiFromProps({ kind: "github" });
    expect(ui && checkWidgetUi(ui)).toEqual([]);
  });

  it("asks the model to send the guardian to Settings where no card shows", () => {
    expect(connectAccountToolOutput("slack", false)).toContain("Settings › Connections");
  });

  it("refuses a kind Rome does not connect itself", () => {
    expect(parseConnectAccountInput({ kind: "notion" })).toMatchObject({ ok: false });
    expect(parseConnectAccountInput({ kind: "github" })).toEqual({ ok: true, kind: "github" });
  });
});
