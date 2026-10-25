import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({ ipcMain: { handle: rs.fn() } }));

import { isInstanceSender, isTrustedSender } from "./ipc-trust";

function from(url: string | undefined) {
  return { senderFrame: url === undefined ? null : { url } } as Parameters<
    typeof isTrustedSender
  >[0];
}

describe("isTrustedSender", () => {
  it("trusts only the app's own file: pages", () => {
    expect(isTrustedSender(from("file:///Applications/Rome.app/settings.html"))).toBe(true);
    expect(isTrustedSender(from("https://ray.romeos.cc/chat"))).toBe(false);
    expect(isTrustedSender(from("http://127.0.0.1:47823/"))).toBe(false);
    expect(isTrustedSender(from(""))).toBe(false);
    expect(isTrustedSender(from(undefined))).toBe(false);
  });
});

describe("isInstanceSender", () => {
  const frame = (url: string, parent: unknown = null) => ({ senderFrame: { url, parent } });
  const origin = "https://ray.romeos.cc";

  it("trusts the top frame of the Rome this launch opened", () => {
    expect(isInstanceSender(frame("https://ray.romeos.cc/settings/devices"), origin)).toBe(true);
  });

  it("refuses other origins, frames inside the page, and a launch with no Rome", () => {
    expect(isInstanceSender(frame("https://accounts.google.com/o/oauth2"), origin)).toBe(false);
    expect(isInstanceSender(frame("https://ray.romeos.cc.evil.example/"), origin)).toBe(false);
    expect(isInstanceSender(frame("https://ray.romeos.cc/apps/x", {}), origin)).toBe(false);
    expect(isInstanceSender(frame("https://ray.romeos.cc/"), null)).toBe(false);
    expect(isInstanceSender({ senderFrame: null }, origin)).toBe(false);
  });
});
