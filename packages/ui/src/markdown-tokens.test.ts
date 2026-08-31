import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

const markdownCss = readFileSync(join(import.meta.dirname, "markdown.css"), "utf8");
const stylesCss = readFileSync(join(import.meta.dirname, "styles.css"), "utf8");

function declarations(source: string, selector: string, from = 0): string {
  const start = source.indexOf(`${selector} {`, from);
  if (start < 0) throw new Error(`Missing CSS block: ${selector}`);
  const bodyStart = source.indexOf("{", start) + 1;
  const end = source.indexOf("}", bodyStart);
  return source.slice(bodyStart, end);
}

const markdownTokenStart = stylesCss.indexOf("MARKDOWN TOKENS");
const normal = declarations(stylesCss, ":host", markdownTokenStart);
const compact = declarations(markdownCss, ".rome-markdown.rome-markdown-compact");

const normalType = {
  "body-font-size": "var(--rome-font-size-16)",
  "body-line-height": "var(--rome-line-height-125)",
  "heading-1-font-size": "var(--rome-font-size-24)",
  "heading-1-line-height": "var(--rome-line-height-133)",
  "heading-2-font-size": "var(--rome-font-size-22)",
  "heading-2-line-height": "var(--rome-line-height-127)",
  "heading-3-font-size": "var(--rome-font-size-20)",
  "heading-3-line-height": "var(--rome-line-height-120)",
  "heading-4-font-size": "var(--rome-font-size-18)",
  "heading-4-line-height": "var(--rome-line-height-133)",
  "heading-floor-font-size": "var(--rome-font-size-16)",
  "heading-floor-line-height": "var(--rome-line-height-125)",
} as const;

const compactType = {
  "body-font-size": "var(--rome-font-size-14)",
  "body-line-height": "var(--rome-line-height-143)",
  "heading-1-font-size": "var(--rome-font-size-20)",
  "heading-1-line-height": "var(--rome-line-height-120)",
  "heading-2-font-size": "var(--rome-font-size-18)",
  "heading-2-line-height": "var(--rome-line-height-133)",
  "heading-3-font-size": "var(--rome-font-size-16)",
  "heading-3-line-height": "var(--rome-line-height-125)",
  "heading-4-font-size": "var(--rome-font-size-14)",
  "heading-4-line-height": "var(--rome-line-height-143)",
  "heading-floor-font-size": "var(--rome-font-size-14)",
  "heading-floor-line-height": "var(--rome-line-height-143)",
} as const;

function expectToken(block: string, name: string, value: string) {
  expect(block).toContain(`--markdown-${name}: ${value};`);
}

describe("Markdown semantic tokens", () => {
  it("keeps Markdown out of the generic typography-role namespace", () => {
    expect(stylesCss).not.toContain("--text-prose-");
    expect(stylesCss).not.toContain("--text-markdown-");
  });

  it("binds the standard prose scale in 2px steps", () => {
    for (const [name, value] of Object.entries(normalType)) expectToken(normal, name, value);
    expectToken(normal, "body-font-weight", "400");
    expectToken(normal, "heading-font-weight", "500");
  });

  it("rebinds the same tokens for compact mode", () => {
    for (const [name, value] of Object.entries(compactType)) expectToken(compact, name, value);
    expect(compact).not.toContain("font-weight");
    expect(compact).not.toContain("letter-spacing");
  });

  it("gives every supported heading level token-owned type at any nesting depth", () => {
    for (let level = 1; level <= 6; level += 1) {
      const block = declarations(
        markdownCss,
        `.rome-markdown [data-streamdown="heading-${level}"]`,
      );
      const token = level <= 4 ? `heading-${level}` : "heading-floor";
      expect(block).toContain(`font-size: var(--markdown-${token}-font-size);`);
      expect(block).toContain(`line-height: var(--markdown-${token}-line-height);`);
    }

    const headings = declarations(markdownCss, '.rome-markdown [data-streamdown^="heading-"]');
    expect(headings).toContain("font-weight: var(--markdown-heading-font-weight);");
    expect(headings).toContain("letter-spacing: var(--markdown-heading-letter-spacing);");
  });

  it("keeps document rhythm on direct children and clears space at both edges", () => {
    for (let level = 1; level <= 4; level += 1) {
      const block = declarations(
        markdownCss,
        `.rome-markdown > [data-streamdown="heading-${level}"]`,
      );
      expect(block).toContain(`var(--markdown-heading-${level}-space-before)`);
      expect(block).toContain(`var(--markdown-heading-${level}-space-after)`);
    }

    const floor = declarations(
      markdownCss,
      '.rome-markdown > :is([data-streamdown="heading-5"], [data-streamdown="heading-6"])',
    );
    expect(floor).toContain("var(--markdown-heading-floor-space-before)");
    expect(floor).toContain("var(--markdown-heading-floor-space-after)");
    expect(declarations(markdownCss, ".rome-markdown > :first-child")).toContain(
      "margin-block-start: 0;",
    );
    expect(declarations(markdownCss, ".rome-markdown > :last-child")).toContain(
      "margin-block-end: 0;",
    );
  });

  it("contains child margins without grid-stretching Markdown media", () => {
    const root = declarations(markdownCss, ".rome-markdown");
    expect(root).toContain("display: flow-root;");
    expect(root).not.toContain("display: grid;");
  });

  it("owns the vertical rhythm for Markdown block anatomy", () => {
    for (const token of [
      "block-space-between",
      "list-space-block",
      "list-item-space-block",
      "code-block-space-block",
      "blockquote-space-block",
      "table-space-block",
      "rule-space-block",
      "media-space-block",
    ]) {
      expect(markdownCss).toContain(`var(--markdown-${token})`);
    }
  });
});
