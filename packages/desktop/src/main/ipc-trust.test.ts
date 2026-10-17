import { describe, expect, it, rs } from "@rstest/core";

rs.mock("electron", () => ({ ipcMain: { handle: rs.fn() } }));

import { isTrustedSender } from "./ipc-trust";

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
