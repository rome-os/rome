import { EventEmitter } from "events";
import { describe, expect, it, rs } from "@rstest/core";

const menus = rs.hoisted(() => [] as Array<Array<{ label?: string; enabled?: boolean }>>);

rs.mock("electron", () => ({
  app: { on: rs.fn() },
  BrowserWindow: class {},
  Menu: {
    buildFromTemplate: (template: Array<{ label?: string; enabled?: boolean }>) => {
      menus.push(template);
      return template;
    },
  },
  Tray: class {
    setToolTip() {}
    setContextMenu() {}
    on() {}
  },
  nativeImage: {
    createFromPath: () => ({ isEmpty: () => true }),
    createFromBuffer: () => ({ setTemplateImage() {} }),
  },
}));
rs.mock("./lifecycle", () => ({ isQuitting: () => false, requestStopAndQuit: rs.fn() }));
rs.mock("./logger", () => ({
  createLogger: () => ({ error: rs.fn(), info: rs.fn(), warn: rs.fn() }),
}));

import type { RuntimeStatus } from "./runtime/provider";
import type { Runtime } from "./runtime/runtime";
import { setupTray, statusLabel } from "./tray";

function status(partial: Partial<RuntimeStatus>): RuntimeStatus {
  return {
    phase: "starting_rome",
    title: "",
    detail: "",
    primaryAction: "none",
    dashboardUrl: "https://ray.romeos.cc",
    lastError: null,
    ...partial,
  };
}

describe("statusLabel", () => {
  it("names the Rome Cloud states", () => {
    expect(statusLabel(null)).toBe("Status: Starting…");
    expect(statusLabel(status({ phase: "ready" }))).toBe("Status: Ready");
    expect(statusLabel(status({ phase: "waiting_for_user", primaryAction: "sign_in" }))).toBe(
      "Status: Not signed in",
    );
    expect(
      statusLabel(status({ phase: "waiting_for_user", primaryAction: "choose_instance" })),
    ).toBe("Status: Waiting for you");
    expect(statusLabel(status({ phase: "failed", lastError: "offline" }))).toBe(
      "Status: Failed — offline",
    );
  });

  // The private VM's install, image and boot phases are gone; whatever is in
  // flight is a hosted Rome being reached.
  it("reads every in-flight phase as connecting", () => {
    expect(statusLabel(status({ phase: "starting_rome" }))).toBe("Status: Connecting…");
    expect(statusLabel(status({ phase: "waiting_for_health" }))).toBe("Status: Connecting…");
  });
});

describe("setupTray", () => {
  // A hosted Rome keeps running after the app quits, so there is no agent to
  // stop on the way out.
  it("offers Quit Rome, never Stop agent and quit", () => {
    const runtime = Object.assign(new EventEmitter(), {
      getStatus: () => status({ phase: "ready" }),
    }) as unknown as Runtime;
    setupTray({
      getMainWindow: () => null,
      ensureMainWindow: rs.fn(),
      openSettings: rs.fn(),
      runtime,
      floatingPill: null,
    });
    const labels = menus.at(-1)?.map((item) => item.label);
    expect(labels).toContain("Quit Rome");
    expect(labels).toContain("Status: Ready");
    expect(labels?.some((label) => /agent|Stopping/.test(label ?? ""))).toBe(false);
  });
});
