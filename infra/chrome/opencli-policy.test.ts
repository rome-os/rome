import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const policy = JSON.parse(
  readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "opencli-policy.json"), "utf8"),
);

describe("opencli-policy.json", () => {
  // Chromium's default DeveloperToolsAvailability blocks DevTools on any page that belongs to a
  // force-installed extension. An about:blank tab the Browser Bridge navigates commits in the
  // extension's SiteInstance, so chrome.debugger and raw CDP both refuse to attach to it, and the
  // next browser session that reclaims the tab fails with "Cannot attach to this target."
  it("allows DevTools on tabs opened by the force-installed Browser Bridge", () => {
    expect(policy.ExtensionSettings.ildkmabpimmkaediidaifkhjpohdnifk.installation_mode).toBe(
      "force_installed",
    );
    expect(policy.DeveloperToolsAvailability).toBe(1);
  });
});
