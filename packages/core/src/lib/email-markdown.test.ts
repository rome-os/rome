import { describe, expect, it } from "@rstest/core";
import {
  cleanPlainText,
  htmlToMarkdown,
  htmlToEmailMultipart,
  inboundBodyToMarkdown,
  isHtml,
  markdownToEmailHtml,
  sanitizeEmailHtml,
} from "./email-markdown.js";

describe("htmlToMarkdown (inbound HTML → Markdown)", () => {
  it("converts basic HTML to markdown", () => {
    const md = htmlToMarkdown("<h1>Title</h1><p>Hello <strong>world</strong></p>");
    expect(md).toContain("# Title");
    expect(md).toContain("**world**");
  });

  it("strips tracking pixels (images) and anchor URLs by default", () => {
    const md = htmlToMarkdown(
      '<p>Hi <a href="https://track.example/abc?u=1">click</a></p><img src="https://track.example/pixel.gif" width="1" height="1">',
    );
    expect(md).toContain("click");
    expect(md).not.toContain("track.example");
    expect(md).not.toContain("![");
  });

  it("keeps link URLs when includeLinks is set", () => {
    const md = htmlToMarkdown('<a href="https://example.com/x">link</a>', true);
    expect(md).toContain("https://example.com/x");
  });

  it("strips invisible filler and folds whitespace", () => {
    const md = htmlToMarkdown("<p>A\u200B\u200B\u00ADB   C</p>");
    expect(md).toBe("AB C");
  });
});

describe("cleanPlainText", () => {
  it("decodes entities, strips bare URLs, and collapses whitespace", () => {
    const out = cleanPlainText("Tom &amp; Jerry visit https://track.x/abc now\u200B.");
    expect(out).toContain("Tom & Jerry");
    expect(out).not.toContain("track.x");
  });
});

describe("isHtml", () => {
  it("detects HTML fragments by tag count", () => {
    expect(isHtml("<div><p>x</p><span>y</span></div>")).toBe(true);
    expect(isHtml("just plain text with a < sign")).toBe(false);
  });
});

describe("inboundBodyToMarkdown", () => {
  it("prefers an existing markdown body", () => {
    expect(inboundBodyToMarkdown({ markdown: "already md", html: "<p>x</p>" })).toBe("already md");
  });

  it("falls back HTML → text → preview", () => {
    expect(inboundBodyToMarkdown({ html: "<p>from <em>html</em></p>" })).toContain("_html_");
    expect(inboundBodyToMarkdown({ text: "from text" })).toBe("from text");
    expect(inboundBodyToMarkdown({}, "the preview")).toBe("the preview");
  });

  it("falls back to the preview when stripped text cleans to empty", () => {
    for (const strippedText of ["https://track.example/message", "\u200B\u00AD", "&nbsp;"]) {
      expect(inboundBodyToMarkdown({ strippedText }, "  The message preview  ")).toBe(
        "The message preview",
      );
    }
  });

  it("preserves the preview when all body alternatives clean to empty", () => {
    expect(
      inboundBodyToMarkdown(
        {
          html: '<img src="https://track.example/pixel.png">',
          text: "https://track.example/message",
          strippedHtml: "<p>&nbsp;</p>",
          strippedText: "https://track.example/message",
        },
        "The message preview",
      ),
    ).toBe("The message preview");
  });

  it("uses nonempty stripped text before the preview", () => {
    expect(inboundBodyToMarkdown({ strippedText: "  Useful body  " }, "preview")).toBe(
      "Useful body",
    );
    expect(inboundBodyToMarkdown({ strippedText: "https://track.example/message" })).toBe("");
  });
});

describe("markdownToEmailHtml (outbound Markdown → HTML)", () => {
  it("produces inlined HTML and keeps the markdown as text/plain", () => {
    const { html, text } = markdownToEmailHtml("# Hi\n\nSome **bold** text.");
    expect(text).toBe("# Hi\n\nSome **bold** text.");
    // The bold renders; juice inlines the prose base style onto it (so the tag
    // carries a `style=`, no longer a bare <strong>).
    expect(html).toContain(">bold</strong>");
    expect(html).toMatch(/<strong style="[^"]*font-weight: 600/);
    // juice inlines the base style onto elements.
    expect(html).toMatch(/style=/);
  });

  it("brands the shell with the header tile and a smaller footer glyph", () => {
    const { html } = markdownToEmailHtml("hello");
    // White app-icon tile in the ember band, 32px.
    expect(html).toContain("https://romeos.cc/public-icon.png");
    expect(html).toMatch(/public-icon\.png"[^>]*width="32"/);
    // Transparent glyph in the footer, smaller (16px) and muted.
    expect(html).toContain("https://romeos.cc/public-transparent.png");
    expect(html).toMatch(/public-transparent\.png"[^>]*width="16"/);
    expect(html).toMatch(/opacity: 0\.55/);
  });
});

describe("dashboard links in outbound mail", () => {
  const origin = "https://acme.romeos.cc";
  const hrefs = (html: string) =>
    [...html.matchAll(/<a\b[^>]*?\bhref="([^"]*)"/g)].map((m) => m[1]);

  it("resolves root-relative links against the instance origin in HTML and text", () => {
    const { html, text } = markdownToEmailHtml(
      [
        'See [file.md](</memory/topics/file.md>) and [plan](/projects/demo/plan.md#todo "Plan").',
        "Watch the [browser](/desktop), or read [notes][n].",
        "",
        "[n]: /memory/notes.md",
      ].join("\n"),
      origin,
    );
    expect(hrefs(html)).toEqual([
      "https://acme.romeos.cc/memory/topics/file.md",
      "https://acme.romeos.cc/projects/demo/plan.md#todo",
      "https://acme.romeos.cc/desktop",
      "https://acme.romeos.cc/memory/notes.md",
      "https://acme.romeos.cc/settings",
    ]);
    expect(text).toBe(
      [
        'See [file.md](<https://acme.romeos.cc/memory/topics/file.md>) and [plan](https://acme.romeos.cc/projects/demo/plan.md#todo "Plan").',
        "Watch the [browser](https://acme.romeos.cc/desktop), or read [notes][n].",
        "",
        "[n]: https://acme.romeos.cc/memory/notes.md",
      ].join("\n"),
    );
  });

  it("leaves external links, other hosts, fragments and code samples as written", () => {
    const markdown = [
      "[docs](https://example.com/docs) [cdn](//cdn.example/x) [top](#top)",
      "",
      "Write `[file.md](</memory/topics/file.md>)` to link a file:",
      "",
      "```md",
      "[plan](/projects/demo/plan.md)",
      "```",
    ].join("\n");
    const { html, text } = markdownToEmailHtml(markdown, origin);
    expect(hrefs(html)).toEqual([
      "https://example.com/docs",
      "//cdn.example/x",
      "#top",
      "https://acme.romeos.cc/settings",
    ]);
    expect(html).toContain("[file.md](&lt;/memory/topics/file.md&gt;)");
    expect(html).toContain("[plan](/projects/demo/plan.md)");
    expect(text).toBe(markdown);
  });

  it("keeps code samples in text/plain as written, a link's label included", () => {
    const { html, text } = markdownToEmailHtml(
      [
        "Write `[a](/memory/a.md)` for [a](/memory/a.md).",
        "The [`[b](/memory/b.md)` form](/memory/b.md) works too.",
      ].join("\n"),
      origin,
    );
    expect(hrefs(html).slice(0, 2)).toEqual([
      "https://acme.romeos.cc/memory/a.md",
      "https://acme.romeos.cc/memory/b.md",
    ]);
    expect(html).toContain(">[a](/memory/a.md)</code>");
    expect(html).toContain(">[b](/memory/b.md)</code>");
    // The first link's source text also sits in a code sample, so text/plain
    // keeps both occurrences as written.
    expect(text).toBe(
      [
        "Write `[a](/memory/a.md)` for [a](/memory/a.md).",
        "The [`[b](/memory/b.md)` form](https://acme.romeos.cc/memory/b.md) works too.",
      ].join("\n"),
    );
  });

  it("leaves links relative and the footer on romeos.cc without an instance origin", () => {
    const { html, text } = markdownToEmailHtml("[file.md](</memory/topics/file.md>)");
    expect(hrefs(html)).toEqual(["/memory/topics/file.md", "https://romeos.cc"]);
    expect(text).toBe("[file.md](</memory/topics/file.md>)");
    expect(hrefs(htmlToEmailMultipart('<a href="/desktop">browser</a>').html)).toEqual([
      "/desktop",
      "https://romeos.cc",
    ]);
  });

  it("resolves links in app HTML, the text derived from it, and the agent's text", () => {
    const app =
      '<p>See <a href="/projects/demo/report.html?v=2">the report</a> or <a href="https://example.com/">example</a>.</p>';
    const derived = htmlToEmailMultipart(app, undefined, origin);
    expect(hrefs(derived.html)).toEqual([
      "https://acme.romeos.cc/projects/demo/report.html?v=2",
      "https://example.com/",
      "https://acme.romeos.cc/settings",
    ]);
    expect(derived.text).toContain(
      "[the report](https://acme.romeos.cc/projects/demo/report.html?v=2)",
    );

    const { text } = htmlToEmailMultipart(
      app,
      "Read [the report](/projects/demo/report.html).",
      origin,
    );
    expect(text).toBe("Read [the report](https://acme.romeos.cc/projects/demo/report.html).");
  });
});

describe("sanitizeEmailHtml / htmlToEmailMultipart", () => {
  it("drops scripts and event handlers", () => {
    const clean = sanitizeEmailHtml('<p onclick="x()">hi</p><script>evil()</script>');
    expect(clean).toContain("hi");
    expect(clean).not.toContain("<script");
    expect(clean).not.toContain("onclick");
  });

  it("derives a text alternative from app HTML", () => {
    const { html, text } = htmlToEmailMultipart("<h2>Report</h2><p>Body line</p>");
    expect(html).toContain("Report");
    expect(text).toContain("Report");
    expect(text).toContain("Body line");
  });

  it("prefers an explicit fallback text over the derived one", () => {
    const { text } = htmlToEmailMultipart("<p>html body</p>", "the agent's words");
    expect(text).toBe("the agent's words");
  });

  it("appends the Rome sign-off footer below app HTML, but keeps it out of text", () => {
    const { html, text } = htmlToEmailMultipart("<p>App body</p>", "agent words");
    expect(html).toContain("App body");
    expect(html).toContain("Sent by Rome");
    expect(html).toContain("https://romeos.cc/public-transparent.png");
    // The footer sits after the app body.
    expect(html.indexOf("App body")).toBeLessThan(html.indexOf("Sent by Rome"));
    // text/plain stays clean (mirrors the markdown path, which omits the footer).
    expect(text).toBe("agent words");
    expect(text).not.toContain("Sent by Rome");
  });

  it("keeps the Rome footer styling isolated from app HTML", () => {
    // App ships generic selectors that would distort the footer if they ever
    // reached it (e.g. the glyph going display:block stacks above the text).
    // sanitizeEmailHtml already strips app <style> blocks, and inlining the
    // footer in its own juice pass keeps it isolated regardless — pin both.
    const appHtml =
      "<style>img{display:block} table{width:600px} td{padding:0}</style>" +
      '<table><tr><td><img src="app.png" /></td></tr></table>';
    const { html } = htmlToEmailMultipart(appHtml, "agent words");

    const footerImg = html.match(/<img[^>]*rome-footer-logo[^>]*>/)?.[0] ?? "";
    expect(footerImg).toContain("width: 16px");
    // App's `img { display:block }` must never reach the footer glyph.
    expect(footerImg).not.toContain("display: block");
    // Still a single well-formed document, not two concatenated.
    expect((html.match(/<\/html>/g) ?? []).length).toBe(1);
  });
});
