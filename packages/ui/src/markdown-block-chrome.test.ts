import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "@rstest/core";

// Comments are stripped so a selector fragment can never match prose about it.
const markdownCss = readFileSync(join(import.meta.dirname, "markdown.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

const CODE_CARD = '[data-streamdown="code-block"]';
const CODE_LABEL = '[data-streamdown="code-block-header"]';
const CODE_ACTIONS = '[data-streamdown="code-block-actions"]';
const CODE_BODY = '[data-streamdown="code-block-body"]';
const DIAGRAM_CARD = '[data-streamdown="mermaid-block"]';
const DIAGRAM_LABEL = '[data-streamdown="mermaid-block"] > :first-child';
const DIAGRAM_ACTIONS = '[data-streamdown="mermaid-block-actions"]';
const DIAGRAM_CANVAS = '[data-streamdown="mermaid-block"] > :last-child';
const ZOOM_STACK = '[data-streamdown="mermaid"] :has(> button[title="Zoom in"])';

/** Every floating part, on both fences. */
const CHROME = [CODE_LABEL, DIAGRAM_LABEL, CODE_ACTIONS, DIAGRAM_ACTIONS, ZOOM_STACK];

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rules(): Array<{ selector: string; declarations: string }> {
  // Selectors are collapsed onto one line: the formatter wraps the long ones,
  // and a fragment should match a selector, not a line break inside it.
  return [...markdownCss.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].replace(/\s+/g, " ").trim(),
    declarations: match[2],
  }));
}

/** The declarations of the first rule whose selector carries every fragment. */
function rule(...fragments: string[]): string {
  const found = rules().find(({ selector }) =>
    fragments.every((fragment) => selector.includes(fragment)),
  );
  if (!found) throw new Error(`No rule matching: ${fragments.join(" + ")}`);
  return found.declarations;
}

/** Everything inside the first `@media` block whose condition carries `query`. */
function media(query: string): string {
  const start = markdownCss.search(new RegExp(`@media[^{]*${escapeRegExp(query)}[^{]*\\{`));
  if (start < 0) throw new Error(`No @media block for: ${query}`);

  const open = markdownCss.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < markdownCss.length; index += 1) {
    if (markdownCss[index] === "{") depth += 1;
    if (markdownCss[index] === "}" && (depth -= 1) === 0) {
      return markdownCss.slice(open + 1, index);
    }
  }
  throw new Error(`Unterminated @media block for: ${query}`);
}

const hoverCapable = media("hover: hover");
const withoutHoverCapable = markdownCss.replace(hoverCapable, "");

describe("Markdown fenced-block chrome", () => {
  it("frames a code fence once — the card keeps the tint, the body goes flush", () => {
    const body = rule(".rome-markdown", CODE_BODY);

    expect(body).toContain("border: 0;");
    expect(body).toContain("background-color: transparent;");
    // The card owns the corners. The body clips its scroll area to those same
    // corners instead of nesting a second, smaller radius inside them.
    expect(body).toContain("border-radius: inherit;");
  });

  it("frames a diagram once the other way round, so its nodes stay visible", () => {
    // Mermaid fills nodes with the same `--surface` the card is tinted with,
    // so the canvas keeps its own fill and the card is the part that goes flat.
    const card = rule(`.rome-markdown ${DIAGRAM_CARD}`);

    expect(card).toContain("border: 0;");
    expect(card).toContain("background-color: transparent;");
    expect(rule(".rome-markdown", DIAGRAM_CANVAS)).toContain("border-radius: inherit;");
  });

  it("seats the language name and the buttons together at the inline end", () => {
    // A card is one grid row of three columns. The name and the buttons take
    // the last two, so they sit side by side however wide either one is, and
    // the `1fr` ahead of them takes every spare pixel.
    // Matched on the whole selector: the block-rhythm rules further up the
    // stylesheet name both cards too, in a list of every Markdown block.
    const card = rule(`.rome-markdown :is(${CODE_CARD}, ${DIAGRAM_CARD})`);
    expect(card).toContain("display: grid;");
    expect(card).toContain("grid-template-columns: 1fr auto auto;");
    expect(rule(`.rome-markdown :is(${CODE_LABEL}, ${DIAGRAM_LABEL})`)).toContain(
      "grid-area: 1 / 2;",
    );
    expect(
      rule(
        `.rome-markdown :is( ${CODE_CARD} > :has(> ${CODE_ACTIONS}),`,
        `${DIAGRAM_CARD} > :has(> ${DIAGRAM_ACTIONS}) )`,
      ),
    ).toContain("grid-area: 1 / 3;");
  });

  it("costs no height — the content holds the same grid row the band does", () => {
    const content = rule(".rome-markdown", CODE_BODY, "> :last-child");

    expect(content).toContain("grid-row: 1;");
    expect(content).toContain("grid-column: 1 / -1;");
    // Without a zero minimum a long line of code widens the columns the band
    // sits in, instead of scrolling inside its own body.
    expect(content).toContain("min-width: 0;");
  });

  it("keeps the band together and reachable down a fence taller than the viewport", () => {
    const band = rule(".rome-markdown", CODE_LABEL, DIAGRAM_LABEL, CODE_ACTIONS, DIAGRAM_ACTIONS);

    expect(band).toContain("position: sticky;");
    expect(band).toContain("inset-block-start: var(--rome-space-2);");
    expect(band).toContain("height: var(--rome-space-8);");
  });

  it("collapses the language name a bare fence leaves empty", () => {
    // ``` with no language still renders the name element, with an empty span.
    // It has to stay in the band — its height is the band's — but a blank chip
    // floating over the content would read as a control.
    const empty = rule(".rome-markdown", CODE_LABEL, "span:empty");

    expect(empty).toContain("padding-inline: 0;");
    expect(empty).toContain("border: 0;");
    expect(empty).toContain("box-shadow: none;");
    expect(empty).toContain("background: none;");
  });

  it("hides every floating part until its fence is hovered or holds focus", () => {
    const [beforeHide] = hoverCapable.split("opacity: 0;");

    expect(hoverCapable).toContain("opacity: 0;");
    for (const hook of CHROME) expect(beforeHide).toContain(hook);

    const [, afterHide] = hoverCapable.split("opacity: 0;");
    expect(afterHide).toMatch(/:is\(\s*:hover,\s*:focus-within\s*\)/);
    expect(afterHide).toContain("opacity: 1;");
    for (const hook of CHROME) expect(afterHide.split("opacity: 1;")[0]).toContain(hook);
  });

  it("keeps the chrome visible where there is no hover to reveal it with", () => {
    // The hide lives inside `(hover: hover)` and nowhere else, so a touch
    // surface never lands in a state where a fence cannot be copied.
    expect(withoutHoverCapable).not.toContain("opacity: 0");
  });

  it("reveals with opacity, which keeps the buttons reachable by keyboard", () => {
    expect(hoverCapable).not.toContain("visibility: hidden");
    expect(hoverCapable).not.toContain("display: none");
  });

  it("leaves a fullscreen diagram's zoom stack alone", () => {
    // Streamdown portals a fullscreen diagram to document.body, outside the
    // prose root. There the zoom stack is the whole interface, so every rule
    // that hides it stays scoped to Markdown rendered in place.
    const hiding = rules().filter(({ selector }) => selector.includes(ZOOM_STACK));

    expect(hiding.length).toBeGreaterThan(0);
    for (const { selector } of hiding) expect(selector.startsWith(".rome-markdown")).toBe(true);
  });
});
