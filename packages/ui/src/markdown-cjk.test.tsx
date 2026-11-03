import { afterEach, describe, expect, it } from "@rstest/core";
import { cleanup, render } from "@testing-library/react";
import { Markdown } from "./markdown.js";

afterEach(cleanup);

function renderMd(md: string) {
  return render(<Markdown>{md}</Markdown>).container;
}

/** Each link in the rendered message as `text -> href`. */
function links(container: HTMLElement): string[] {
  return [...container.querySelectorAll("a")].map(
    (link) => `${link.textContent} -> ${link.getAttribute("href")}`,
  );
}

const strong = (container: HTMLElement) =>
  [...container.querySelectorAll('[data-streamdown="strong"]')].map((node) => node.textContent);

describe("Markdown bare URLs in CJK prose", () => {
  it.each<[string, string, string]>([
    [
      "看 https://github.com/rome-os/rome/pull/1552，CI 在跑",
      "https://github.com/rome-os/rome/pull/1552",
      "https://github.com/rome-os/rome/pull/1552",
    ],
    ...["。", "、", "；", "：", "！", "？", "）", "」", "』", "》", "】", "〉"].map(
      (mark): [string, string, string] => [
        `见 https://x.com/a${mark}后面`,
        "https://x.com/a",
        "https://x.com/a",
      ],
    ),
    ["（见 https://x.com/a）后面", "https://x.com/a", "https://x.com/a"],
    ["前文https://x.com/a，后面", "https://x.com/a", "https://x.com/a"],
    [
      "https://x.com/search?q=a&b=1，后面",
      "https://x.com/search?q=a&b=1",
      "https://x.com/search?q=a&b=1",
    ],
    [
      "https://zh.wikipedia.org/wiki/中文，后面",
      "https://zh.wikipedia.org/wiki/中文",
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
    ],
    [
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87，后面",
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
      "https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87",
    ],
  ])("ends %s at the full-width punctuation", (md, text, href) => {
    const container = renderMd(md);

    expect(links(container)).toEqual([`${text} -> ${href}`]);
    // The punctuation and the words after it stay in the message as text.
    expect(container.textContent).toBe(md);
  });

  it("links each URL in a run joined by full-width semicolons", () => {
    const container = renderMd("https://a.com/x；https://b.com/y；https://c.com/z");

    expect(links(container)).toEqual([
      "https://a.com/x -> https://a.com/x",
      "https://b.com/y -> https://b.com/y",
      "https://c.com/z -> https://c.com/z",
    ]);
  });

  it.each<[string, string[]]>([
    [
      "https://zh.wikipedia.org/wiki/中文 页面",
      ["https://zh.wikipedia.org/wiki/中文 -> https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87"],
    ],
    [
      "https://ja.wikipedia.org/wiki/ジョン・レノン 参照",
      [
        "https://ja.wikipedia.org/wiki/ジョン・レノン -> https://ja.wikipedia.org/wiki/%E3%82%B8%E3%83%A7%E3%83%B3%E3%83%BB%E3%83%AC%E3%83%8E%E3%83%B3",
      ],
    ],
    [
      "https://en.wikipedia.org/wiki/Foo_(bar) and more",
      ["https://en.wikipedia.org/wiki/Foo_(bar) -> https://en.wikipedia.org/wiki/Foo_(bar)"],
    ],
    [
      "https://x.com/a, next. (see https://x.com/b) and https://x.com/c.",
      [
        "https://x.com/a -> https://x.com/a",
        "https://x.com/b -> https://x.com/b",
        "https://x.com/c -> https://x.com/c",
      ],
    ],
    ["[链接](https://x.com/a，b)，后面", ["链接 -> https://x.com/a%EF%BC%8Cb"]],
  ])("keeps %s linked as before", (md, expected) => {
    expect(links(renderMd(md))).toEqual(expected);
  });

  it("does not link URLs inside code", () => {
    const container = renderMd("`https://x.com/a，b`\n\n```\nhttps://x.com/a，b\n```");

    expect(links(container)).toEqual([]);
  });

  it("ends a URL in a table cell at the full-width punctuation", () => {
    const container = renderMd("| 链接 |\n| --- |\n| https://x.com/a，b |");

    expect(links(container)).toEqual(["https://x.com/a -> https://x.com/a"]);
    expect(container.querySelector("td")?.textContent).toBe("https://x.com/a，b");
  });

  it("ends a still-streaming URL at the punctuation as soon as it arrives", () => {
    const { container, rerender } = render(<Markdown>看 https://x.com/a</Markdown>);
    expect(links(container)).toEqual(["https://x.com/a -> https://x.com/a"]);

    rerender(<Markdown>看 https://x.com/a，C</Markdown>);
    expect(links(container)).toEqual(["https://x.com/a -> https://x.com/a"]);

    rerender(<Markdown>看 https://x.com/a，CI 在跑</Markdown>);
    expect(links(container)).toEqual(["https://x.com/a -> https://x.com/a"]);
  });
});

describe("Markdown emphasis beside CJK punctuation", () => {
  // CommonMark will not close `**` after punctuation that a CJK letter follows,
  // so these used to render their asterisks literally.
  it.each<[string, string]>([
    ["这是**「引用」**文字", "「引用」"],
    ["**“引号”**后面", "“引号”"],
    ["**加粗（括号）**后面", "加粗（括号）"],
    ["前文**（括号）**后文", "（括号）"],
  ])("bolds %s", (md, bold) => {
    const container = renderMd(md);

    expect(strong(container)).toEqual([bold]);
    expect(container.textContent).not.toContain("*");
  });

  it("strikes through text wrapped in CJK brackets", () => {
    expect(renderMd("前~~「删除」~~后").querySelector("del")?.textContent).toBe("「删除」");
  });

  it.each<[string, string[]]>([
    ["**粗体**，后面", ["粗体"]],
    ["这是**加粗**文字", ["加粗"]],
    ["*外层 **内层** 外层*", ["内层"]],
    ["***粗斜体***，后", ["粗斜体"]],
    ["This is **bold**, *italic*, and ***both***.", ["bold", "both"]],
  ])("renders %s as before", (md, bold) => {
    expect(strong(renderMd(md))).toEqual(bold);
  });

  it("leaves intraword underscores and asterisks in English alone", () => {
    const container = renderMd("snake_case_name and 2*3*4");

    expect(container.textContent).toBe("snake_case_name and 234");
    expect(container.querySelector("em")?.textContent).toBe("3");
  });

  it("keeps asterisks inside code literal", () => {
    const container = renderMd("`**不是粗体**`\n\n```\n**不是粗体**\n```");

    expect(strong(container)).toEqual([]);
    expect(container.querySelector("code")?.textContent).toBe("**不是粗体**");
  });

  it("bolds a still-streaming span that opens beside CJK punctuation", () => {
    const { container, rerender } = render(<Markdown>这是**「引</Markdown>);
    expect(strong(container)).toEqual(["「引"]);

    rerender(<Markdown>这是**「引用」**文字</Markdown>);
    expect(strong(container)).toEqual(["「引用」"]);
  });
});
