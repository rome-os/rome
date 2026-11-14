import { checkWidgetUi } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  connectAccountToolOutput,
  connectCardUiFromProps,
  parseConnectAccountInput,
} from "./connect-card.js";

describe("connect_account", () => {
  // Where Rome Cloud is set up, as on a provisioned instance.
  beforeEach(() => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
  });
  afterEach(() => {
    rs.unstubAllEnvs();
  });

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

  it("says why instead of showing a card whose Connect could only fail", () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "");
    rs.stubEnv("PANTHEON_DOMAIN", "");
    const output = connectAccountToolOutput("github", true);
    expect(typeof output).toBe("string");
    expect(output).toContain("Settings › Connections");
  });

  it("refuses a kind Rome does not connect itself", () => {
    expect(parseConnectAccountInput({ kind: "notion" })).toMatchObject({ ok: false });
    expect(parseConnectAccountInput({ kind: "github" })).toEqual({ ok: true, kind: "github" });
  });
});
