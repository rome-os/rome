// @rstest-environment jsdom

import { afterEach, describe, expect, it } from "@rstest/core";
import { prepareShadowMount } from "./rome-app-host";

afterEach(() => {
  document.body.replaceChildren();
});

describe("prepareShadowMount", () => {
  it("maps the app's background compatibility token onto the app canvas", () => {
    const host = document.createElement("div");
    document.body.append(host);

    prepareShadowMount(host);

    const shellCss = host.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(shellCss).toContain("--background: var(--app-canvas)");
    expect(shellCss).toContain("background-color: var(--app-canvas)");
  });
});
