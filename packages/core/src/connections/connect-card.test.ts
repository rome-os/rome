import { checkWidgetUi } from "@rome-os/app-runtime";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  connectAccountToolOutput,
  connectCardUiFromProps,
  deviceConnectToolOutput,
  deviceKinds,
  parseConnectAccountInput,
} from "./connect-card.js";
import type { DeviceConnection } from "./device/repository.js";

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

describe("connect_account for a device kind", () => {
  const row = (deviceId: string, capability: string, title: string) =>
    ({ device: { id: deviceId }, capability, title }) as DeviceConnection;

  it("takes its device kinds from what devices reported, each once, never an OAuth kind's name", () => {
    expect(
      deviceKinds([
        row("dev-1", "apple_health", "Apple Health"),
        row("dev-2", "apple_health", "Apple Health"),
        row("dev-1", "device", "Device"),
        row("dev-1", "github", "Not GitHub"),
      ]),
    ).toEqual([
      { kind: "apple_health", label: "Apple Health" },
      { kind: "device", label: "Device" },
    ]);
  });

  it("parses a reported device kind, and lists it among the kinds when refusing", () => {
    const devices = [{ kind: "apple_health", label: "Apple Health" }];
    expect(parseConnectAccountInput({ kind: "apple_health" }, devices)).toEqual({
      ok: true,
      kind: "apple_health",
      device: devices[0],
    });
    const refused = parseConnectAccountInput({ kind: "location" }, devices);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.error).toContain('"apple_health"');
  });

  it("shows a card every reader can draw, whose events say the kind is a device's", () => {
    const device = { kind: "apple_health", label: "Apple Health" };
    expect(deviceConnectToolOutput(device, true)).toMatchObject({
      pendingInteraction: true,
      render: {
        componentId: "connect-card",
        props: { kind: "apple_health", label: "Apple Health", device: true },
      },
    });
    const ui = connectCardUiFromProps({
      kind: "apple_health",
      label: "Apple Health",
      device: true,
    });
    expect(ui && checkWidgetUi(ui)).toEqual([]);
    expect(JSON.stringify(ui)).toContain('"context":{"kind":"apple_health","device":true}');
    const texts = (ui?.components ?? []).flatMap((c) => ("text" in c ? [c.text] : []));
    expect(texts).toEqual([
      "Connect Apple Health",
      "So your Rome can read the Apple Health data you allow.",
      "Not now",
      "Connect",
    ]);
    expect(deviceConnectToolOutput(device, false)).toContain("Rome app");
  });
});
