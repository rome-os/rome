import { describe, expect, it } from "@rstest/core";
import { shareableOrigin } from "./shareable-origin";

const at = (url: string) => {
  const { hostname, origin } = new URL(url);
  return shareableOrigin({ hostname, origin });
};

describe("shareableOrigin", () => {
  it("keeps a host other people can reach", () => {
    expect(at("https://jessie.romeos.cc/apps/x")).toBe("https://jessie.romeos.cc");
    expect(at("http://100.64.0.7:8080/")).toBe("http://100.64.0.7:8080");
  });

  it("offers no origin on a loopback host", () => {
    for (const url of [
      "http://127.0.0.1:54321/",
      "http://localhost:3200/",
      "http://app.rome.localhost:3000/",
      "http://[::1]:4141/",
    ]) {
      expect(at(url)).toBeNull();
    }
  });
});
