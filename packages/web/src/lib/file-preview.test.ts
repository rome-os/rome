import { describe, expect, it } from "@rstest/core";
import {
  getDelimitedSeparator,
  getTextPreviewKind,
  parseDelimitedContent,
} from "@/lib/file-preview";

describe("file preview helpers", () => {
  it("detects markdown and delimited text preview types", () => {
    expect(getTextPreviewKind("memory/IDENTITY.md", "text/markdown")).toBe("markdown");
    expect(getTextPreviewKind("projects/data/report.csv", "text/csv")).toBe("delimited");
    expect(getTextPreviewKind("projects/data/report.tsv", "text/plain")).toBe("delimited");
    expect(getTextPreviewKind("projects/demo/index.html", "text/html")).toBe("html");
    expect(getTextPreviewKind("memory/page.htm", "text/plain")).toBe("html");
    expect(getTextPreviewKind("projects/src/index.ts", "text/typescript")).toBeNull();
  });

  it("selects the TSV separator from extension or MIME type", () => {
    expect(getDelimitedSeparator("projects/data/report.tsv", "text/plain")).toBe("\t");
    expect(getDelimitedSeparator("projects/data/report.txt", "text/tab-separated-values")).toBe(
      "\t",
    );
    expect(getDelimitedSeparator("projects/data/report.csv", "text/csv")).toBe(",");
  });

  it("parses CSV rows with quoted values", () => {
    expect(
      parseDelimitedContent('name,note\nAda,"hello, world"\nLinus,"said ""hi"""', ","),
    ).toEqual([
      ["name", "note"],
      ["Ada", "hello, world"],
      ["Linus", 'said "hi"'],
    ]);
  });

  it("parses TSV rows", () => {
    expect(parseDelimitedContent("name\tscore\nAda\t10", "\t")).toEqual([
      ["name", "score"],
      ["Ada", "10"],
    ]);
  });
});
