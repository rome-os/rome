import { beforeEach, describe, expect, it, rs } from "@rstest/core";
import { diagram, peleThemeDeclarations } from "./diagram-renderer.js";
import { readMarkdownMermaidTheme } from "./markdown.js";

// jsdom has no canvas, so Pele measures text with its built-in estimates.
// Answering null up front keeps jsdom from logging that on every render.
beforeEach(() => {
  rs.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

describe("diagram renderer", () => {
  it("renders Mermaid source to a Pele SVG", async () => {
    const { svg } = await diagram.getMermaid().render("mermaid-1", "graph TD; A-->B;");
    expect(svg).toMatch(/^<svg\b[^>]*class="pele pele-flowchart"/);
    expect(svg).toContain(">A<");
  });

  it("renders the diagram types Rome's agents write most", async () => {
    const sources = [
      "sequenceDiagram\n  Alice->>Bob: Hello",
      "classDiagram\n  Animal <|-- Duck",
      "stateDiagram-v2\n  [*] --> Idle",
      "erDiagram\n  CUSTOMER ||--o{ ORDER : places",
      "gantt\n  title Plan\n  section A\n  Task :a1, 2024-01-01, 3d",
      'pie title Pets\n  "Dogs" : 3\n  "Cats" : 2',
      "mindmap\n  root((Rome))\n    Apps",
    ];
    for (const source of sources) {
      const { svg } = await diagram.getMermaid().render("mermaid-types", source);
      expect(svg).toMatch(/^<svg\b/);
    }
  });

  it("puts the Mermaid theme on the SVG as Pele variables", async () => {
    const renderer = diagram.getMermaid({
      fontFamily: "Inter, sans-serif",
      themeVariables: { primaryColor: "#112233", lineColor: "#445566" },
    });
    const { svg } = await renderer.render("mermaid-2", "graph TD; A-->B;");
    const style = svg.match(/^<svg\b[^>]*\bstyle="([^"]*)"/)?.[1] ?? "";
    expect(
      style.startsWith("--pele-muted:#445566;--pele-line:#445566;--pele-surface:#112233;"),
    ).toBe(true);
    expect(style).toContain("font-family:var(--pele-font,Inter, sans-serif)");
  });

  it("renders with the config from the latest initialize", async () => {
    const renderer = diagram.getMermaid({ themeVariables: { lineColor: "#000000" } });
    renderer.initialize({ themeVariables: { lineColor: "#ffffff" } });
    const { svg } = await renderer.render("mermaid-3", "graph TD; A-->B;");
    expect(svg).toContain("--pele-line:#ffffff");
    expect(svg).not.toContain("#000000");
  });

  it("rejects a diagram type Pele does not know, so Streamdown shows its error", async () => {
    await expect(
      diagram.getMermaid().render("mermaid-4", "zenuml\n  title Demo\n  A.method()"),
    ).rejects.toThrow();
  });

  it("rejects invalid syntax", async () => {
    await expect(diagram.getMermaid().render("mermaid-5", "graph TD; A-->")).rejects.toThrow();
  });
});

describe("peleThemeDeclarations", () => {
  it("maps each Pele slot from the first Mermaid variable that is set", () => {
    expect(
      peleThemeDeclarations({
        themeVariables: {
          mainBkg: "#fafafa",
          textColor: "#111111",
          lineColor: "#888888",
          clusterBkg: "#eeeeee",
          primaryBorderColor: "#cccccc",
          activationBkgColor: "#3366ff",
        },
      }),
    ).toBe(
      [
        "--pele-bg:#fafafa",
        "--pele-fg:#111111",
        "--pele-muted:#888888",
        "--pele-line:#888888",
        "--pele-surface:#fafafa",
        "--pele-surface-alt:#eeeeee",
        "--pele-border:#cccccc",
        "--pele-accent:#3366ff",
      ].join(";"),
    );
  });

  it("fills every Pele slot from a host's Markdown theme tokens", () => {
    const { themeVariables } = readMarkdownMermaidTheme({
      tokens: {
        foreground: "#1a130f",
        surface: "#fdfcf9",
        surfaceMuted: "#efe9e1",
        primary: "#d86f4c",
        line: "#8a7868",
      },
    });
    expect(peleThemeDeclarations({ themeVariables })).toBe(
      [
        "--pele-bg:#fdfcf9",
        "--pele-fg:#1a130f",
        "--pele-muted:#8a7868",
        "--pele-line:#8a7868",
        "--pele-surface:#fdfcf9",
        "--pele-surface-alt:#efe9e1",
        "--pele-border:#8a7868",
        "--pele-accent:#d86f4c",
      ].join(";"),
    );
  });

  it("drops values that could end the declaration and escapes quotes", () => {
    expect(
      peleThemeDeclarations({
        themeVariables: {
          primaryColor: "red;background:url(x)",
          textColor: "</svg>",
          mainBkg: 42,
          lineColor: 'rgb(0 0 0)" onload="alert(1)',
        },
      }),
    ).toBe(
      [
        "--pele-muted:rgb(0 0 0)&quot; onload=&quot;alert(1)",
        "--pele-line:rgb(0 0 0)&quot; onload=&quot;alert(1)",
      ].join(";"),
    );
  });

  it("returns nothing without theme variables", () => {
    expect(peleThemeDeclarations(undefined)).toBe("");
    expect(peleThemeDeclarations({ theme: "base" })).toBe("");
  });
});
