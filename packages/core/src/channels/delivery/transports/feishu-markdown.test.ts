import { describe, expect, it } from "@rstest/core";
import { feishuMarkdown } from "./feishu.js";

describe("Feishu fenced Markdown", () => {
  it("keeps code comments and blank lines in an unfinished fence", () => {
    expect(feishuMarkdown.render("```python\n# Important comment\n\n\nx = 1", false)).toBe(
      "```python\n# Important comment\n\n\nx = 1\n```",
    );
  });

  it("closes a settled part whose source continues inside code", () => {
    expect(feishuMarkdown.render("```python\n# Important comment\nx = 1\n", true)).toBe(
      "```python\n# Important comment\nx = 1\n```",
    );
  });

  it("reopens the fence from the source before a continuation", () => {
    expect(
      feishuMarkdown.render("# Another comment\nx = 2\n```\n# End", true, {
        before: "```python\n# Important comment\nx = 1\n",
      }),
    ).toBe("```python\n# Another comment\nx = 2\n```\n#### End");
  });

  it("keeps a continuation in the middle of a code line inside its fence", () => {
    expect(
      feishuMarkdown.render("second half\n```", true, {
        before: "```text\nfirst half ",
      }),
    ).toBe("```text\nsecond half\n```");
  });

  it("never shrinks a rendering as its source grows through a closing fence", () => {
    const source = "Intro\n\n```python\n# comment\nx = 1\n```\n\nDone";
    for (const settled of [false, true]) {
      let previous = 0;
      for (let end = 1; end <= source.length; end++) {
        const size = feishuMarkdown.measure(feishuMarkdown.render(source.slice(0, end), settled));
        expect(size).toBeGreaterThanOrEqual(previous);
        previous = size;
      }
    }
  });

  it("handles tilde fences and shorter backtick runs inside a longer fence", () => {
    expect(feishuMarkdown.render("~~~~md\n# code\n~~~\n", false)).toBe("~~~~md\n# code\n~~~\n~~~~");
    expect(feishuMarkdown.render("````md\n```\n# code\n", false)).toBe("````md\n```\n# code\n````");
  });
});
