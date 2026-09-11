// packages/core/src/apps/og/template.test.ts
import { describe, expect, it } from "@rstest/core";
import { renderOgSvg, wrapText } from "./template.js";

const base = {
  name: "Reddit Radar",
  description: "Watches subreddits",
  link: "jessie.romeos.cc/full/apps/reddit",
  icon: null,
};

describe("wrapText", () => {
  it("breaks English at the last space and CJK by character", () => {
    expect(wrapText("AI agent Reddit radar with scheduled ingestion", 30, 2)).toEqual([
      "AI agent Reddit radar with",
      "scheduled ingestion",
    ]);
    expect(wrapText("自动完成小红书选题调研", 8, 2)).toEqual(["自动完成", "小红书…"]);
  });

  it("adds an ellipsis when text is left over, staying within budget", () => {
    const lines = wrapText("one two three four five six seven", 10, 2);
    expect(lines).toHaveLength(2);
    expect(lines[1].endsWith("…")).toBe(true);
    expect(lines[1].length).toBeLessThanOrEqual(10);
  });

  it("hard-cuts a single word longer than the budget", () => {
    expect(wrapText("abcdefghijkl", 5, 1)).toEqual(["abcd…"]);
  });
});

describe("renderOgSvg", () => {
  it("escapes text and places the slots", () => {
    const svg = renderOgSvg({ ...base, name: 'A <b> & "c"', description: "d & e" });
    expect(svg).toContain("A &lt;b&gt; &amp; &quot;c&quot;");
    expect(svg).toContain("d &amp; e");
    expect(svg).toContain("jessie.romeos.cc/full/apps/reddit");
    expect(svg).toContain("Built on Rome");
    expect(svg).toMatch(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1200" height="630"/);
  });

  it("uses one 64px line for a short name and two 48px lines for a long one", () => {
    expect(renderOgSvg(base)).toContain('font-size="64"');
    const long = renderOgSvg({ ...base, name: "Enterprise Customer Research Assistant Pro" });
    expect(long).toContain('font-size="48"');
    expect(long).not.toContain('font-size="64"');
  });

  it("embeds svg and png icons as data URIs and falls back to the Rome mark", () => {
    const svgIcon = renderOgSvg({
      ...base,
      icon: { mime: "image/svg+xml", bytes: Buffer.from("<svg/>") },
    });
    expect(svgIcon).toContain('href="data:image/svg+xml;base64,PHN2Zy8+"');
    const pngIcon = renderOgSvg({
      ...base,
      icon: { mime: "image/png", bytes: Buffer.from([1, 2, 3]) },
    });
    expect(pngIcon).toContain('href="data:image/png;base64,AQID"');
    expect(renderOgSvg(base)).not.toContain('href="data:');
  });

  it("omits the link line when there is no host", () => {
    const svg = renderOgSvg({ ...base, link: null });
    expect(svg).not.toContain('y="566"');
  });

  it("wraps a long description across two lines, no third baseline", () => {
    const long =
      "This app watches every subreddit you care about and ranks the best posts of the day.";
    const svg = renderOgSvg({ ...base, description: long });
    const spans = svg.match(/<tspan x="96" y="\d+">/g) ?? [];
    expect(spans).toHaveLength(2);
    expect(svg).toContain('<tspan x="96" y="396">');
    expect(svg).toContain('<tspan x="96" y="444">');
    expect(svg).not.toContain('<tspan x="96" y="492">');
  });

  it("renders no description line when description is null", () => {
    const svg = renderOgSvg({ ...base, description: null });
    expect(svg).not.toContain('<tspan x="96"');
  });
});
