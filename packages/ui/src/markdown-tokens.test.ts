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
  "body-line-height": "var(--rome-line-height-150)",
  "heading-1-font-size": "var(--rome-font-size-30)",
  "heading-1-line-height": "var(--rome-line-height-120)",
  "heading-2-font-size": "var(--rome-font-size-24)",
  "heading-2-line-height": "var(--rome-line-height-133)",
  "heading-3-font-size": "var(--rome-font-size-20)",
  "heading-3-line-height": "var(--rome-line-height-140)",
  "heading-4-font-size": "var(--rome-font-size-16)",
  "heading-4-line-height": "var(--rome-line-height-150)",
  "heading-floor-font-size": "var(--rome-font-size-16)",
  "heading-floor-line-height": "var(--rome-line-height-150)",
} as const;

const compactType = {
  "body-font-size": "var(--rome-font-size-14)",
  "body-line-height": "var(--rome-line-height-143)",
  "heading-1-font-size": "var(--rome-font-size-22)",
  "heading-1-line-height": "var(--rome-line-height-127)",
  "heading-2-font-size": "var(--rome-font-size-18)",
  "heading-2-line-height": "var(--rome-line-height-133)",
  "heading-3-font-size": "var(--rome-font-size-16)",
  "heading-3-line-height": "var(--rome-line-height-150)",
  "heading-4-font-size": "var(--rome-font-size-14)",
  "heading-4-line-height": "var(--rome-line-height-143)",
  "heading-floor-font-size": "var(--rome-font-size-14)",
  "heading-floor-line-height": "var(--rome-line-height-143)",
} as const;

// Space before a heading, at each density, against the paragraph gap it must
// clear and the space-after it must outweigh.
const normalRhythm = {
  gap: 16,
  headings: {
    "heading-1": { before: 32, after: 8 },
    "heading-2": { before: 28, after: 8 },
    "heading-3": { before: 24, after: 8 },
    "heading-4": { before: 24, after: 8 },
    "heading-floor": { before: 24, after: 4 },
  },
} as const;

const compactRhythm = {
  gap: 8,
  headings: {
    "heading-1": { before: 16, after: 4 },
    "heading-2": { before: 16, after: 4 },
    "heading-3": { before: 12, after: 4 },
    "heading-4": { before: 12, after: 4 },
    "heading-floor": { before: 12, after: 4 },
  },
} as const;

const SPACE_PX: Record<string, number> = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 7: 28, 8: 32 };

function spaceToken(block: string, name: string): number {
  const match = block.match(new RegExp(`--markdown-${name}: var\\(--rome-space-(\\d+)\\);`));
  if (!match) throw new Error(`Missing token: --markdown-${name}`);
  return SPACE_PX[match[1]];
}

function expectToken(block: string, name: string, value: string) {
  expect(block).toContain(`--markdown-${name}: ${value};`);
}

describe("Markdown semantic tokens", () => {
  it("keeps Markdown out of the generic typography-role namespace", () => {
    expect(stylesCss).not.toContain("--text-prose-");
    expect(stylesCss).not.toContain("--text-markdown-");
  });

  it("binds the standard prose scale: body on 1.5, headings stepping by at least 1.2", () => {
    for (const [name, value] of Object.entries(normalType)) expectToken(normal, name, value);
    expectToken(normal, "body-font-weight", "400");
    // Headings match inline emphasis, so a bold label never outweighs its heading.
    expectToken(normal, "heading-font-weight", "600");
  });

  it.each([
    ["standard", () => normal, normalRhythm],
    ["compact", () => compact, compactRhythm],
  ] as const)("gives every %s heading more space above than the paragraph gap, and less below", (_density, block, rhythm) => {
    expect(spaceToken(block(), "block-space-between")).toBe(rhythm.gap);
    for (const [level, { before, after }] of Object.entries(rhythm.headings)) {
      expect(spaceToken(block(), `${level}-space-before`)).toBe(before);
      expect(spaceToken(block(), `${level}-space-after`)).toBe(after);
      expect(before).toBeGreaterThanOrEqual(rhythm.gap * 1.5);
      expect(before / after).toBeGreaterThanOrEqual(2.5);
    }
  });

  it("seats an edged block one grid step further from text than text sits", () => {
    for (const [block, rhythm] of [
      [normal, normalRhythm],
      [compact, compactRhythm],
    ] as const) {
      for (const name of ["code-block", "blockquote", "table", "media"]) {
        expect(spaceToken(block, `${name}-space-block`)).toBe(rhythm.gap + 4);
      }
      // A list item carries its own padding; margin plus padding meets the gap.
      expect(
        spaceToken(block, "list-space-block") + spaceToken(normal, "list-item-space-block"),
      ).toBe(rhythm.gap);
    }
  });

  it("keeps a heading's space-before after any block, and only there", () => {
    // The rule that flattens whatever follows a list, table, fence or quote
    // stops short of headings; a heading directly after a heading stays tight.
    expect(markdownCss).toContain('+ :not([data-streamdown^="heading-"]) {');
    expect(
      declarations(
        markdownCss,
        '.rome-markdown > [data-streamdown^="heading-"] + [data-streamdown^="heading-"]',
      ),
    ).toContain("margin-block-start: 0;");
  });

  it("hangs list markers outside the text column", () => {
    const list = declarations(
      markdownCss,
      '.rome-markdown :is([data-streamdown="ordered-list"], [data-streamdown="unordered-list"])',
    );
    expect(list).toContain("list-style-position: outside;");
    expect(list).toContain("padding-inline-start: calc(var(--markdown-body-font-size) * 1.5);");
  });

  it("sets a table as text in the column, at the body size", () => {
    const wrapper = declarations(markdownCss, '.rome-markdown [data-streamdown="table-wrapper"]');
    expect(wrapper).toContain("border: 0;");
    expect(wrapper).toContain("padding: 0;");
    expect(wrapper).toContain("background: transparent;");
    for (const cell of ["table-header-cell", "table-cell"]) {
      const block = declarations(markdownCss, `.rome-markdown [data-streamdown="${cell}"]`);
      expect(block).toContain("font-size: inherit;");
      expect(block).toContain("line-height: inherit;");
      expect(block).toContain("border-bottom: 1px solid");
    }
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

  it("sizes inline code off the line box each density resolves to", () => {
    // The tint paints the monospace content area — 1.3em — so 14px paints
    // 18.2px. Standard's 24px line box holds it; compact's stops at 20px,
    // where it merges with the span on the line above.
    expectToken(normal, "inline-code-font-size", "var(--rome-font-size-14)");
    expectToken(compact, "inline-code-font-size", "var(--rome-font-size-13)");

    const inlineCode = declarations(markdownCss, '[data-streamdown="inline-code"]');
    expect(inlineCode).toContain("font-size: var(--markdown-inline-code-font-size);");
    // Vertical padding would paint outside the line box, over the lines around it.
    expect(inlineCode).not.toContain("py-");
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
