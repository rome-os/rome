// @rstest-environment jsdom

import { afterEach, describe, expect, it, rs } from "@rstest/core";
import { appendScopedStyles, prepareShadowMount } from "./rome-app-host";

afterEach(() => {
  document.body.replaceChildren();
  rs.restoreAllMocks();
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

describe("appendScopedStyles", () => {
  it("resolves relative asset URLs against the root-relative stylesheet URL", async () => {
    rs.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        [
          '@import "theme.css";',
          ".a{background:url(images/marker.png)}",
          ".b{background:url('../shared/icon.svg')}",
          '.c{background:url("data:image/png;base64,AAAA")}',
          ".d{background:url(/fonts/x.woff2)}",
          ".e{fill:url(#grad)}",
        ].join("\n"),
      ),
    );
    const host = document.createElement("div");
    document.body.append(host);
    const shadowRoot = host.attachShadow({ mode: "open" });

    await appendScopedStyles(shadowRoot, ["/app-assets/demo/0123456789ab/index.css"]);

    const css = shadowRoot.querySelector("style")?.textContent ?? "";
    const base = `${location.origin}/app-assets/demo`;
    expect(css).toContain(`@import "${base}/0123456789ab/theme.css"`);
    expect(css).toContain(`url("${base}/0123456789ab/images/marker.png")`);
    expect(css).toContain(`url("${base}/shared/icon.svg")`);
    expect(css).toContain('url("data:image/png;base64,AAAA")');
    expect(css).toContain("url(/fonts/x.woff2)");
    expect(css).toContain("url(#grad)");
  });
});
