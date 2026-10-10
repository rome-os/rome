import { describe, expect, it } from "@rstest/core";
import {
  DOCX_PREVIEW_OPTIONS,
  getDocxPreviewPageScale,
  renderDocxPreviewDetached,
  sanitizeDocxPreviewLinks,
} from "@/components/docx-preview-pane";

describe("DOCX preview rendering", () => {
  it("calculates fit-to-width scale while preserving aspect ratio", () => {
    expect(getDocxPreviewPageScale(800, 400)).toBe(0.5);
    expect(getDocxPreviewPageScale(800, 1600)).toBe(1.15);
    expect(getDocxPreviewPageScale(0, 400)).toBe(1);
  });

  it("renders into detached containers before callers commit to live DOM", async () => {
    const createdElements: HTMLElement[] = [];
    const blob = new Blob(["docx"]);
    const renderCalls: Array<{
      bodyElement: HTMLElement;
      options: unknown;
      styleElement: HTMLElement;
    }> = [];
    const createElement = (tagName: string) => {
      const element = {
        childNodes: [],
        innerHTML: "",
        tagName,
      } as unknown as HTMLElement;
      createdElements.push(element);
      return element;
    };

    const render = async (
      _blob: Blob,
      bodyElement: HTMLElement,
      styleElement: HTMLElement,
      options: unknown,
    ) => {
      renderCalls.push({ bodyElement, options, styleElement });
    };

    const rendered = await renderDocxPreviewDetached(blob, render, createElement);

    expect(createdElements).toHaveLength(2);
    expect(renderCalls).toEqual([
      {
        bodyElement: createdElements[0],
        options: DOCX_PREVIEW_OPTIONS,
        styleElement: createdElements[1],
      },
    ]);
    expect(rendered).toEqual({
      bodyElement: createdElements[0],
      styleElement: createdElements[1],
    });
  });
});

describe("sanitizeDocxPreviewLinks", () => {
  it("keeps safe links but forces isolated new-tab navigation", () => {
    const safeLinks = [
      createFakeAnchor("https://example.com/report"),
      createFakeAnchor("http://example.com/report"),
      createFakeAnchor("mailto:ops@example.com"),
      createFakeAnchor("tel:+15555550100"),
      createFakeAnchor("/local/path"),
    ];

    sanitizeDocxPreviewLinks(createFakeRoot(safeLinks));

    for (const link of safeLinks) {
      expect(link.getAttribute("href")).toBeTruthy();
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    }
  });

  it("keeps fragment links in the current preview document", () => {
    const fragmentLink = createFakeAnchor("#toc-target");
    fragmentLink.setAttribute("target", "_blank");
    fragmentLink.setAttribute("rel", "noopener noreferrer");

    sanitizeDocxPreviewLinks(createFakeRoot([fragmentLink]));

    expect(fragmentLink.getAttribute("href")).toBe("#toc-target");
    expect(fragmentLink.getAttribute("target")).toBeNull();
    expect(fragmentLink.getAttribute("rel")).toBeNull();
  });

  it("removes unsafe DOCX-rendered hyperlink targets", () => {
    const unsafeLinks = [
      createFakeAnchor("javascript:alert(document.cookie)"),
      createFakeAnchor("data:text/html,<script>alert(1)</script>"),
      createFakeAnchor("ftp://example.com/file"),
      createFakeAnchor("not a url"),
      createFakeAnchor(""),
    ];

    sanitizeDocxPreviewLinks(createFakeRoot(unsafeLinks));

    for (const link of unsafeLinks) {
      expect(link.getAttribute("href")).toBeNull();
      expect(link.getAttribute("target")).toBeNull();
      expect(link.getAttribute("rel")).toBeNull();
    }
  });
});

function createFakeRoot(links: FakeAnchor[]): Pick<Element, "querySelectorAll"> {
  return {
    querySelectorAll: () => links as unknown as NodeListOf<Element>,
  } as Pick<Element, "querySelectorAll">;
}

class FakeAnchor {
  private readonly attributes = new Map<string, string>();

  constructor(href: string) {
    this.attributes.set("href", href);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }
}

function createFakeAnchor(href: string): FakeAnchor {
  return new FakeAnchor(href);
}
