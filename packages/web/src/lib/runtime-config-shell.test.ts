import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@rstest/core";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf-8");

// Caddy serves this shell straight from
// disk, so the runtime config must be a sibling file the shell references
// unconditionally — the core-side halves of this contract are covered in
// packages/core/src/lib/{runtime-config,caddyfile-generator}.test.ts.
describe("runtime-config shell delivery", () => {
  it("index.html references /runtime-config.js unconditionally", () => {
    const html = read("../../index.html");
    expect(html).toContain('<script src="/runtime-config.js"></script>');
    // It must load before the app bundle, i.e. live in <head>.
    expect(html.indexOf('src="/runtime-config.js"')).toBeLessThan(html.indexOf("</head>"));
  });

  it("ships an inert dev stub for the boot script to overwrite", () => {
    const stub = read("../../public/runtime-config.js");
    expect(stub).toContain("window.__ROME_RUNTIME_CONFIG__ = {};");
    expect(stub).not.toContain("gaMeasurementId");
  });
});
