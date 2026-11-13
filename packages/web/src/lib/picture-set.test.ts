import { describe, expect, it } from "@rstest/core";
import { parsePictureSet, pictureLayout } from "./picture-set";

const ASSET = "/api/projects/asset/maui.png?path=projects%2Fdemo%2Fmaui.png";

describe("parsePictureSet", () => {
  it("reads a picture, its title and its note from a line", () => {
    const set = parsePictureSet(
      "![Oʻahu](https://upload.wikimedia.org/a/960px-x.jpg) Waikiki and Diamond Head, good for a first trip\n",
    );
    expect(set).toEqual({
      layout: "grid",
      pictures: [
        {
          src: "https://upload.wikimedia.org/a/960px-x.jpg",
          title: "Oʻahu",
          note: "Waikiki and Diamond Head, good for a first trip",
          host: "upload.wikimedia.org",
        },
      ],
    });
  });

  it("maps a project or memory file to the asset route, with no host label", () => {
    const set = parsePictureSet(
      "![Maui](/projects/demo/maui.png) Palm trees\n![Note](/memory/pictures/n.png)\n",
    );
    expect(set?.pictures.map(({ src, host, note }) => [src, host, note])).toEqual([
      [ASSET, null, "Palm trees"],
      ["/api/memory/asset/n.png?path=memory%2Fpictures%2Fn.png", null, ""],
    ]);
  });

  it("keeps a stored upload's address", () => {
    const src = "/api/assets/0123456789abcdef0123456789abcdef.png";
    expect(parsePictureSet(`![Shot](${src})\n`)?.pictures[0]).toMatchObject({ src, host: null });
  });

  it("drops a leading www. from the host label and nothing else", () => {
    const set = parsePictureSet(
      "![A](https://www.example.com/a.jpg)\n![B](https://images.example.org/b.jpg)\n",
    );
    expect(set?.pictures.map((p) => p.host)).toEqual(["example.com", "images.example.org"]);
  });

  it("accepts an optional title and angle brackets as a Markdown image does", () => {
    const set = parsePictureSet('![A](<https://example.com/a.jpg> "Caption") note\n');
    expect(set?.pictures[0]).toMatchObject({ src: "https://example.com/a.jpg", note: "note" });
  });

  it("keeps balanced parentheses in an address whole", () => {
    const fuji =
      "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1b/Mount_Fuji_(Japan).jpg/960px-Mount_Fuji_(Japan).jpg";
    const set = parsePictureSet(
      `![Fuji](${fuji}) Spring\n![One](https://example.com/photo_(1).jpg)\n![Two](/memory/pictures/a_(2).png) Note\n`,
    );
    expect(set?.pictures.map(({ src, note }) => [src, note])).toEqual([
      [fuji, "Spring"],
      ["https://example.com/photo_(1).jpg", ""],
      ["/api/memory/asset/a_(2).png?path=memory%2Fpictures%2Fa_(2).png", "Note"],
    ]);
  });

  it("reads an escaped label and shows it unescaped", () => {
    const set = parsePictureSet(
      "![photo \\[1\\].png](https://example.com/a.png) Beach\n![a \\\\ b \\x](https://example.com/b.png)\n",
    );
    expect(set?.pictures.map(({ title, note }) => [title, note])).toEqual([
      ["photo [1].png", "Beach"],
      ["a \\ b \\x", ""],
    ]);
  });

  it("keeps text after the image's parenthesis as the note", () => {
    const set = parsePictureSet(
      "![a](https://example.com/b.jpg) (c)\n![d](https://example.com/e.jpg)(f)\n",
    );
    expect(set?.pictures.map(({ src, note }) => [src, note])).toEqual([
      ["https://example.com/b.jpg", "(c)"],
      ["https://example.com/e.jpg", "(f)"],
    ]);
  });

  it("still drops an unsafe address that has parentheses", () => {
    expect(
      parsePictureSet("![a](javascript:alert(1))\n![b](http://example.com/b_(1).jpg)\n"),
    ).toBeNull();
  });

  it("leaves a note empty when the line has none", () => {
    expect(parsePictureSet("![A](https://example.com/a.jpg)\n")?.pictures[0]?.note).toBe("");
  });

  it("skips lines that are not a picture line", () => {
    const set = parsePictureSet(
      [
        "A heading line",
        "",
        "![A](https://example.com/a.jpg) first",
        "- ![B](https://example.com/b.jpg) a bullet",
        "![C](https://example.com/c.jpg",
        "![D](https://example.com/d.jpg) fourth",
      ].join("\n"),
    );
    expect(set?.pictures.map((p) => p.title)).toEqual(["A", "D"]);
  });

  it.each([
    "javascript:alert(1)",
    "data:image/png;base64,AAAA",
    "http://example.com/a.jpg",
    "//example.com/a.jpg",
    "/not/an/asset.png",
    "relative/path.png",
    "ftp://example.com/a.jpg",
    "/api/projects/other/a.png",
    "/api/share/token/projects/asset/a.png",
    "/projects/../secret.png",
    "/api/assets/0123456789abcdef0123456789abcdef.mp4",
    "https://example.com/clip.mp4",
  ])("drops %s", (src) => {
    expect(parsePictureSet(`![A](${src})\n`)).toBeNull();
  });

  it("keeps the safe lines when others are unsafe", () => {
    const set = parsePictureSet(
      "![A](javascript:alert(1))\n![B](http://example.com/b.jpg)\n![C](https://example.com/c.jpg)\n",
    );
    expect(set?.pictures.map((p) => p.title)).toEqual(["C"]);
  });

  it("returns null when no line yields a safe picture", () => {
    expect(parsePictureSet("")).toBeNull();
    expect(parsePictureSet("just text\nmore text\n")).toBeNull();
    expect(parsePictureSet("![A](http://example.com/a.jpg)\n")).toBeNull();
  });

  it("leaves out a last line that is still being written", () => {
    const body = "![A](https://example.com/a.jpg) first\n![B](https://example.com/b.jpg) seco";
    expect(parsePictureSet(body, { complete: false })?.pictures.map((p) => p.note)).toEqual([
      "first",
    ]);
    expect(parsePictureSet(body, { complete: true })?.pictures.map((p) => p.note)).toEqual([
      "first",
      "seco",
    ]);
  });

  it("returns null while the only line is still being written", () => {
    expect(parsePictureSet("![A](https://example.com/a.jpg) fir", { complete: false })).toBeNull();
  });

  it("reads CRLF lines", () => {
    const set = parsePictureSet(
      "![A](https://example.com/a.jpg) one\r\n![B](https://example.com/b.jpg) two\r\n",
    );
    expect(set?.pictures.map((p) => p.note)).toEqual(["one", "two"]);
  });

  it("takes the layout from the fence's meta", () => {
    const body = "![A](https://example.com/a.jpg)\n";
    expect(parsePictureSet(body)?.layout).toBe("grid");
    expect(parsePictureSet(body, { meta: "grid" })?.layout).toBe("grid");
    expect(parsePictureSet(body, { meta: "list" })?.layout).toBe("list");
  });
});

describe("pictureLayout", () => {
  it.each([
    [undefined, "grid"],
    ["", "grid"],
    ["grid", "grid"],
    ["list", "list"],
    ["list ", "list"],
    ["  list extra", "list"],
    ["List", "grid"],
    ["carousel", "grid"],
  ] as const)("reads %j as %s", (meta, layout) => {
    expect(pictureLayout(meta)).toBe(layout);
  });
});
