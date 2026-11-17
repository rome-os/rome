import { checkWidgetUi } from "@rome-os/app-runtime";
import { locationCardUi } from "@rome/api-types/location-card";
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
  const row = (
    deviceId: string,
    capability: string,
    title: string,
    state: DeviceConnection["state"] = "off",
  ) => ({ device: { id: deviceId, name: "iPhone" }, capability, title, state }) as DeviceConnection;

  it("takes its device kinds from what devices reported, each once at its best state, never an OAuth kind's name", () => {
    expect(
      deviceKinds([
        row("dev-1", "apple_health", "Apple Health", "off"),
        row("dev-2", "apple_health", "Apple Health", "working"),
        row("dev-1", "device", "Device", "broken"),
        row("dev-1", "github", "Not GitHub"),
      ]),
    ).toEqual([
      { kind: "apple_health", label: "Apple Health", state: "working", device: "iPhone" },
      { kind: "device", label: "Device", state: "broken", device: "iPhone" },
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
    // A card stored before devices declared their words: the generic line.
    const texts = (ui?.components ?? []).flatMap((c) => ("text" in c ? [c.text] : []));
    expect(texts).toEqual([
      "Apple Health",
      { string: "deviceConnectNote" },
      { string: "notNow" },
      { string: "connect" },
    ]);
    expect(deviceConnectToolOutput(device, false)).toContain("Rome app");
  });

  it("words the card as the capability's page does, in the guardian's language where the device has it", () => {
    const device = {
      kind: "apple_calendar",
      label: "Calendar",
      icon: "calendar",
      summary: "Your Rome reads your calendars.",
      labels: {
        en: { title: "Calendar", summary: "Your Rome reads your calendars." },
        "zh-CN": { title: "日历", summary: "你的 Rome 会读取你的日历。" },
      },
    };
    const props = (language: string | null) =>
      (
        deviceConnectToolOutput(device, true, undefined, language) as {
          render: { props: Record<string, unknown> };
        }
      ).render.props;
    expect(props("zh-CN")).toMatchObject({ title: "日历", summary: "你的 Rome 会读取你的日历。" });
    expect(props("ja")).toMatchObject({
      title: "Calendar",
      summary: "Your Rome reads your calendars.",
    });
    expect(props(null)).toMatchObject({ title: "Calendar" });
    const ui = connectCardUiFromProps(props("zh-CN"));
    expect(ui && checkWidgetUi(ui)).toEqual([]);
    const texts = (ui?.components ?? []).flatMap((c) => ("text" in c ? [c.text] : []));
    expect(texts.slice(0, 2)).toEqual(["日历", "你的 Rome 会读取你的日历。"]);
    expect(ui?.components.find((c) => c.id === "title")).toMatchObject({ icon: "calendar" });
    // A name no reader draws leaves the title without one.
    const odd = connectCardUiFromProps({ ...props("en"), icon: "rocket" });
    expect(odd && checkWidgetUi(odd)).toEqual([]);
    expect(odd?.components.find((c) => c.id === "title")).not.toHaveProperty("icon");
  });

  it("is one family with the share-location card: the same parts, in the same order", () => {
    const connect = connectCardUiFromProps({
      kind: "apple_health",
      label: "Apple Health",
      title: "Apple Health",
      icon: "heart",
      device: true,
    });
    const location = locationCardUi("To find coffee near you");
    const shape = (ui: typeof location | null) =>
      ui?.components.map((c) => [c.id, c.component, "variant" in c ? c.variant : undefined]);
    expect(shape(connect)).toEqual(shape(location));
    expect(location.components.find((c) => c.id === "title")).toMatchObject({
      icon: "map-pin",
      text: { string: "shareLocationTitle" },
    });
    expect(checkWidgetUi(location)).toEqual([]);
  });
});
