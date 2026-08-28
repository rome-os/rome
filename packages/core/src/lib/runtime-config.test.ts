import { describe, expect, it } from "@rstest/core";
import { RUNTIME_CONFIG_FILENAME, buildRuntimeConfigJs } from "./runtime-config.js";

describe("buildRuntimeConfigJs", () => {
  it("emits an empty config when the measurement id is absent or blank", () => {
    for (const gaMeasurementId of [null, "", "   "]) {
      const js = buildRuntimeConfigJs({ gaMeasurementId });
      expect(js).toContain("window.__ROME_RUNTIME_CONFIG__ = {};");
      expect(js).not.toContain("gaMeasurementId");
    }
  });

  it("emits the trimmed measurement id", () => {
    const js = buildRuntimeConfigJs({ gaMeasurementId: "  G-ABC123  " });
    expect(js).toContain('window.__ROME_RUNTIME_CONFIG__ = {"gaMeasurementId":"G-ABC123"};');
  });

  it("always assigns the full object so a removed id overwrites a stale one", () => {
    // The boot script rewrites the file every container start; the emitted JS
    // must be a complete assignment, not a conditional patch.
    expect(buildRuntimeConfigJs({ gaMeasurementId: null })).toContain(
      "window.__ROME_RUNTIME_CONFIG__ =",
    );
  });

  it("escapes a hostile measurement id so it cannot break out of a script context", () => {
    const js = buildRuntimeConfigJs({ gaMeasurementId: '"</script><script>alert(1)' });
    expect(js).not.toContain("</script>");
    expect(js).not.toContain("<script>");
    // The value survives round-tripping: eval-equivalent via JSON on the
    // emitted literal.
    const literal = js.match(/window\.__ROME_RUNTIME_CONFIG__ = (.*);/)?.[1];
    expect(literal).toBeDefined();
    expect(JSON.parse(literal as string)).toEqual({
      gaMeasurementId: '"</script><script>alert(1)',
    });
  });

  it("keeps the filename in lockstep with the shell reference", () => {
    // packages/web/index.html references /runtime-config.js unconditionally
    // and the Caddyfile serves exactly this path.
    expect(RUNTIME_CONFIG_FILENAME).toBe("runtime-config.js");
  });
});
