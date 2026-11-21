import { describe, expect, it } from "@rstest/core";
import { assetKind, mediaKindOfSrc, parseAssetHref, splitUploadLines } from "./asset-links";

const ID = "0123456789abcdef0123456789abcdef";
const line = (n: number, label: string, name = `${ID}.png`) =>
  `- File ${n}: [${label}](</api/assets/${name}>)`;

describe("splitUploadLines", () => {
  it("splits the server's list off the end of a message", () => {
    const result = splitUploadLines(
      `Look at these\n\n${line(1, "image.png")}\n${line(2, "notes.pdf", `${ID}.pdf`)}`,
    );
    expect(result.text).toBe("Look at these");
    expect(result.uploads).toEqual([
      { label: "image.png", url: `/api/assets/${ID}.png`, kind: "image" },
      { label: "notes.pdf", url: `/api/assets/${ID}.pdf`, kind: "pdf" },
    ]);
  });

  it("leaves no text when the message is only files, and unescapes the label", () => {
    const result = splitUploadLines(line(1, "a\\[1\\].png"));
    expect(result.text).toBe("");
    expect(result.uploads[0]?.label).toBe("a[1].png");
  });

  it("does not split older /projects lines", () => {
    const text = "Look\n\n- File 1: [image.png](</projects/default/2026/11/11/image.png>)";
    expect(splitUploadLines(text)).toEqual({ text, uploads: [] });
  });

  it("does not split a line in the middle of the text", () => {
    const text = `${line(1, "image.png")}\n\nand then some more words`;
    expect(splitUploadLines(text)).toEqual({ text, uploads: [] });
  });

  it("needs a blank line before the list", () => {
    const text = `My notes\n${line(1, "image.png")}`;
    expect(splitUploadLines(text)).toEqual({ text, uploads: [] });
  });

  it("does not split a link that is not a stored name, or a mixed list", () => {
    for (const bad of [
      "- File 1: [x.png](</api/assets/x.png>)",
      "- File 1: [x.png](</api/assets/../projects/asset>)",
      `- File 1: [x.png](</api/assets/${ID.toUpperCase()}.png>)`,
      "- File 1: [x.png](</etc/x.png>)",
    ]) {
      expect(splitUploadLines(`Hi\n\n${bad}`).uploads, bad).toEqual([]);
    }
    // The server never mixes the two, so a list that does is left as text.
    const mixed = `Hi\n\n- File 1: [a.png](</projects/a/a.png>)\n${line(2, "b.png")}`;
    expect(splitUploadLines(mixed)).toEqual({ text: mixed, uploads: [] });
  });

  it("leaves ordinary text and the optimistic list alone", () => {
    for (const text of ["Here is a list:\n- one\n- two", "Hi\n\n- File 1: image.png"]) {
      expect(splitUploadLines(text)).toEqual({ text, uploads: [] });
    }
  });
});

describe("asset kinds", () => {
  it.each([
    ["png", "image"],
    ["SVG", "image"],
    ["mp4", "video"],
    ["mov", "video"],
    ["mp3", "audio"],
    ["ogg", "audio"],
    ["pdf", "pdf"],
    ["zip", "file"],
    ["bin", "file"],
  ])("sorts .%s as %s", (extension, kind) => {
    expect(assetKind(extension)).toBe(kind);
  });

  it("reads the media kind of a src, ignoring its query", () => {
    expect(mediaKindOfSrc(`/api/assets/${ID}.mp4`)).toBe("video");
    expect(mediaKindOfSrc("https://example.com/a.WEBM?x=1#t")).toBe("video");
    expect(mediaKindOfSrc("/a.wav")).toBe("audio");
    expect(mediaKindOfSrc("/a.png")).toBeNull();
    expect(mediaKindOfSrc("/a")).toBeNull();
  });

  it("recognises a link to a stored file, relative or same-origin", () => {
    expect(parseAssetHref(`/api/assets/${ID}.pdf`)).toEqual({
      path: `/api/assets/${ID}.pdf`,
      kind: "pdf",
    });
    expect(parseAssetHref(`/api/assets/${ID}.mp4?x=1`)?.kind).toBe("video");
    for (const href of [
      undefined,
      "/api/assets/x.png",
      `/api/assets/${ID}`,
      "/projects/a.png",
      `https://example.com/api/assets/${ID}.png`,
    ]) {
      expect(parseAssetHref(href), String(href)).toBeNull();
    }
  });
});
