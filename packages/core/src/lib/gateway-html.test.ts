import { describe, expect, it } from "@rstest/core";
import { buildGatewayHtml, type GatewayPageInput } from "./gateway-html.js";

const baseInput: GatewayPageInput = {
  publicAccessConfig: {
    enableAccessControl: true,
    allowedApps: ["morning-brief"],
    cloudEmailAccess: {},
  },
  instanceName: "Test",
  romeCloudSlug: null,
  romeCloudDomain: null,
};

describe("buildGatewayHtml GA snippet", () => {
  it("omits the snippet when no measurement id is configured", () => {
    for (const input of [
      baseInput,
      { ...baseInput, gaMeasurementId: null },
      { ...baseInput, gaMeasurementId: "  " },
    ]) {
      const html = buildGatewayHtml(input);
      expect(html).not.toContain("googletagmanager");
      expect(html).not.toContain("gtag");
    }
  });

  it("emits the stock snippet with the configured id and no URL rewriting", () => {
    const html = buildGatewayHtml({ ...baseInput, gaMeasurementId: "G-ABC123" });
    expect(html).toContain('src="https://www.googletagmanager.com/gtag/js?id=G-ABC123"');
    expect(html).toContain('gtag("config", "G-ABC123");');
    // Stock config only: raw URLs are the accepted exposure —
    // no page_path override, no sanitizer.
    expect(html).not.toContain("page_path");
    expect(html).not.toContain("page_location");
  });

  it("escapes a hostile measurement id in both the URL and the config literal", () => {
    const html = buildGatewayHtml({
      ...baseInput,
      gaMeasurementId: '"</script><script>alert(1)',
    });
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("</script><script>");
  });
});
