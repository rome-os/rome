import { checkWidgetUi } from "@rome-os/app-runtime";
import { locationCardUi } from "@rome/api-types/location-card";
import { afterEach, beforeEach, describe, expect, it, rs } from "@rstest/core";
import {
  type ConnectCardSources,
  connectCardRequest,
  connectCardUiFromProps,
  type DeviceKind,
  deviceKinds,
  parseConnectAccountInput,
} from "./connect-card.js";
import type { DeviceConnection } from "./device/repository.js";

/** The connect card asked for `kind`, where a card connects it. */
async function cardFor(kind: string, sources: ConnectCardSources = {}) {
  const request = await connectCardRequest({ kind }, sources);
  if (request.status !== "card") throw new Error(`expected a card, got ${request.status}`);
  return request;
}

/** The same for a device kind, in the guardian's `language`. */
function deviceCard(device: DeviceKind, language?: string | null) {
  return cardFor(device.kind, { devices: [device], language: async () => language ?? null });
}

describe("the connect card", () => {
  // Where Rome Cloud is set up, as on a provisioned instance.
  beforeEach(() => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "https://cloud.example");
  });
  afterEach(() => {
    rs.unstubAllEnvs();
  });

  it("shows a card every reader can draw", async () => {
    expect((await cardFor("github")).props).toEqual({ kind: "github" });
    const ui = connectCardUiFromProps({ kind: "github" });
    expect(ui && checkWidgetUi(ui)).toEqual([]);
  });

  it("asks the guardian to connect in Settings where no card shows", async () => {
    expect((await cardFor("github")).ask).toContain("Settings › Connections");
  });

  it("says why instead of showing a card whose Connect could only fail", async () => {
    rs.stubEnv("PANTHEON_BASE_ORIGIN", "");
    rs.stubEnv("PANTHEON_DOMAIN", "");
    const request = await connectCardRequest({ kind: "github" }, {});
    expect(request).toMatchObject({
      status: "answer",
      message: expect.stringContaining("Settings › Connections"),
    });
  });

  it("refuses a kind Rome does not connect itself", () => {
    expect(parseConnectAccountInput({ kind: "notion" })).toMatchObject({ ok: false });
    expect(parseConnectAccountInput({ kind: "github" })).toEqual({ ok: true, kind: "github" });
  });
});

describe("the connect card for a device kind", () => {
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

  it("keeps a kind's summary when the devices that report it change state", () => {
    const summarized = (
      deviceId: string,
      summary: string,
      state: DeviceConnection["state"],
    ): DeviceConnection => ({ ...row(deviceId, "device", "Device", state), summary });
    const summaryOf = (first: DeviceConnection["state"], second: DeviceConnection["state"]) =>
      deviceKinds([
        summarized("dev-1", "Reads this phone's battery.", first),
        summarized("dev-2", "Reads this phone's battery and network.", second),
      ])[0]?.summary;
    expect(summaryOf("off", "working")).toBe("Reads this phone's battery.");
    expect(summaryOf("working", "off")).toBe("Reads this phone's battery.");
  });

  it("takes a later device's summary when the first reported none, whatever their states", () => {
    const summaryOf = (first: DeviceConnection["state"], second: DeviceConnection["state"]) =>
      deviceKinds([
        row("dev-1", "device", "Device", first),
        { ...row("dev-2", "device", "Device", second), summary: "Reads this phone's battery." },
      ])[0]?.summary;
    expect(summaryOf("working", "off")).toBe("Reads this phone's battery.");
    expect(summaryOf("off", "working")).toBe("Reads this phone's battery.");
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

  it("shows a card every reader can draw, whose events say the kind is a device's", async () => {
    const device = { kind: "apple_health", label: "Apple Health" };
    expect((await deviceCard(device)).props).toMatchObject({
      kind: "apple_health",
      label: "Apple Health",
      device: true,
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
      { path: "/romeStrings/deviceConnectNote" },
      { path: "/romeStrings/notNow" },
      { path: "/romeStrings/connect" },
    ]);
    // An app that does not know these words draws the English the card carries.
    expect(ui?.data).toEqual({
      romeStrings: {
        deviceConnectNote: "So your Rome can read the data you allow.",
        notNow: "Not now",
        connect: "Connect",
      },
    });
    expect((await deviceCard(device)).ask).toContain("Rome app");
  });

  it("words the card as the capability's page does, in the guardian's language where the device has it", async () => {
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
    const props = async (language: string | null) => (await deviceCard(device, language)).props;
    expect(await props("zh-CN")).toMatchObject({
      title: "日历",
      summary: "你的 Rome 会读取你的日历。",
    });
    expect(await props("ja")).toMatchObject({
      title: "Calendar",
      summary: "Your Rome reads your calendars.",
    });
    expect(await props(null)).toMatchObject({ title: "Calendar" });
    const ui = connectCardUiFromProps(await props("zh-CN"));
    expect(ui && checkWidgetUi(ui)).toEqual([]);
    const texts = (ui?.components ?? []).flatMap((c) => ("text" in c ? [c.text] : []));
    expect(texts.slice(0, 2)).toEqual(["日历", "你的 Rome 会读取你的日历。"]);
    expect(ui?.components.find((c) => c.id === "title")).toMatchObject({ icon: "calendar" });
    // A name no reader draws leaves the title without one.
    const odd = connectCardUiFromProps({ ...(await props("en")), icon: "rocket" });
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
      text: { path: "/romeStrings/shareLocationTitle" },
    });
    expect(location.data).toMatchObject({
      romeStrings: { shareLocationTitle: "Share your location?" },
    });
    expect(checkWidgetUi(location)).toEqual([]);
  });
});
