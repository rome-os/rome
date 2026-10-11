// @rstest-environment jsdom

import { afterEach, describe, expect, it } from "@rstest/core";
// `rome run` (packages/app-web-sdk) mounts an app outside the dashboard with a
// copy of this host's CSS handling.
import {
  PAGE_SHELL_CSS,
  scopeAppCss as runScopeAppCss,
} from "../../../app-web-sdk/assets/host-mount.js";
import { prepareShadowMount, scopeAppCss } from "./rome-app-host";

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
    expect(shellCss).toContain("background-color: var(--background)");
  });

  it("inherits the surrounding canvas for inline chat components", () => {
    const host = document.createElement("div");
    document.body.append(host);

    prepareShadowMount(host, { canvas: "chat" });

    const shellCss = host.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(shellCss).not.toContain("--background: var(--app-canvas)");
    expect(shellCss).toContain("--background: var(--chat-canvas)");
    expect(shellCss).toContain("--app-canvas: var(--chat-canvas)");
    expect(shellCss).toContain("background-color: transparent");
  });
});

describe("app-web-sdk host-mount copy", () => {
  it("scopes app CSS the way the dashboard does", () => {
    const source = "https://rome.test/app-assets/demo/1.0.0/static/css/index.css";
    const css = [
      ":root { --x: 1; }",
      '@import "./theme.css";',
      "@import url(../fonts.css);",
      '@import "/absolute.css";',
      '.a { background: url("../img/a.png"); }',
      ".b { background: url(data:image/png;base64,AAAA); }",
      ".c { background: url('https://cdn.test/c.png'); }",
      ".d { mask: url(#mask); }",
    ].join("\n");

    expect(runScopeAppCss(css, source)).toBe(scopeAppCss(css, source));
  });

  it("gives a page mount the same canvas shell", () => {
    const host = document.createElement("div");
    document.body.append(host);

    prepareShadowMount(host);

    const normalize = (css: string) => css.replace(/\s+/g, " ").trim();
    const shellCss = host.shadowRoot?.querySelector("style")?.textContent ?? "";
    expect(normalize(PAGE_SHELL_CSS)).toBe(normalize(shellCss));
  });
});
