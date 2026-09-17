import { useEffect, useRef, useState } from "react";
import { renderAsync } from "docx-preview";
import { useTranslation } from "react-i18next";

interface DocxPreviewPaneProps {
  assetUrl: string;
  title: string;
}

type DocxPreviewRenderer = typeof renderAsync;

const SAFE_DOCX_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);

export const DOCX_PREVIEW_OPTIONS = {
  breakPages: true,
  className: "docx-preview",
  ignoreFonts: false,
  ignoreHeight: false,
  ignoreLastRenderedPageBreak: false,
  ignoreWidth: false,
  inWrapper: false,
  renderAltChunks: false,
  renderComments: true,
  renderEndnotes: true,
  renderFooters: true,
  renderFootnotes: true,
  renderHeaders: true,
  useBase64URL: true,
} as const;

const DOCX_PREVIEW_PAGE_SELECTOR = `section.${DOCX_PREVIEW_OPTIONS.className}`;
const DOCX_PREVIEW_PAGE_SHELL_CLASS = "docx-preview-page-shell";
const DOCX_PREVIEW_MAX_SCALE = 1.15;

export const DOCX_PREVIEW_LAYOUT_CSS = `
.docx-preview-pane .docx-preview-pages {
  box-sizing: border-box;
  min-height: 100%;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
  background: var(--color-surface);
}

.docx-preview-pane .docx-preview-page-shell {
  flex: 0 0 auto;
  max-width: 100%;
  overflow: hidden;
}

.docx-preview-pane .docx-preview-page-shell > .docx-preview {
  box-sizing: border-box;
  margin: 0 !important;
  background: white;
  color: #111;
  box-shadow: none;
  transform-origin: top left;
}

@media (max-width: 640px) {
  .docx-preview-pane .docx-preview-pages {
    padding: 0;
    gap: 0;
  }
}
`;

export function getDocxPreviewPageScale(
  pageWidth: number,
  availableWidth: number,
  maxScale: number = DOCX_PREVIEW_MAX_SCALE,
): number {
  if (pageWidth <= 0 || availableWidth <= 0 || maxScale <= 0) {
    return 1;
  }

  return Math.min(maxScale, availableWidth / pageWidth);
}

function getElementInnerWidth(element: HTMLElement): number {
  const styles = window.getComputedStyle(element);
  const paddingX = parseFloat(styles.paddingLeft) + parseFloat(styles.paddingRight);
  return Math.max(0, element.clientWidth - paddingX);
}

function wrapDocxPreviewPages(bodyElement: HTMLElement): HTMLElement[] {
  const pages = Array.from(bodyElement.querySelectorAll<HTMLElement>(DOCX_PREVIEW_PAGE_SELECTOR));

  for (const page of pages) {
    if (page.parentElement?.classList.contains(DOCX_PREVIEW_PAGE_SHELL_CLASS)) {
      continue;
    }

    const shell = document.createElement("div");
    shell.className = DOCX_PREVIEW_PAGE_SHELL_CLASS;
    page.parentNode?.insertBefore(shell, page);
    shell.appendChild(page);
  }

  return pages;
}

function resizeDocxPreviewPages(bodyElement: HTMLElement, targets?: HTMLElement[]): void {
  const availableWidth = getElementInnerWidth(bodyElement);
  const pages =
    targets ?? Array.from(bodyElement.querySelectorAll<HTMLElement>(DOCX_PREVIEW_PAGE_SELECTOR));

  // Read phase: collect all measurements before any writes to avoid layout thrashing.
  const measurements = pages.map((page) => ({
    page,
    shell: page.parentElement,
    width: page.offsetWidth,
    height: Math.max(page.offsetHeight, page.scrollHeight),
  }));

  // Write phase: apply transforms without interleaved reads.
  for (const { page, shell, width, height } of measurements) {
    if (!shell?.classList.contains(DOCX_PREVIEW_PAGE_SHELL_CLASS)) {
      continue;
    }
    const scale = getDocxPreviewPageScale(width, availableWidth);
    page.style.transform = `scale(${scale})`;
    shell.style.width = `${width * scale}px`;
    shell.style.height = `${height * scale}px`;
  }
}

function isSafeDocxPreviewHref(href: string): boolean {
  const trimmed = href.trim();
  if (!trimmed) {
    return false;
  }

  const hasExplicitProtocol = /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed);
  const isRelativeLink =
    trimmed.startsWith("/") || trimmed.startsWith("#") || trimmed.startsWith("?");
  if (!hasExplicitProtocol && !isRelativeLink) {
    return false;
  }

  try {
    const baseUrl = typeof document === "undefined" ? "https://rome.local/" : document.baseURI;
    const url = new URL(trimmed, baseUrl);
    return SAFE_DOCX_LINK_PROTOCOLS.has(url.protocol);
  } catch {
    return false;
  }
}

export function sanitizeDocxPreviewLinks(root: Pick<Element, "querySelectorAll">): void {
  root.querySelectorAll("a").forEach((link) => {
    const href = link.getAttribute("href");
    const trimmedHref = href?.trim();
    if (!href || !isSafeDocxPreviewHref(href)) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      link.removeAttribute("rel");
      return;
    }

    if (trimmedHref?.startsWith("#")) {
      link.removeAttribute("target");
      link.removeAttribute("rel");
      return;
    }

    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
  });
}

export async function renderDocxPreviewDetached(
  blob: Blob,
  render: DocxPreviewRenderer = renderAsync,
  createElement: (tagName: string) => HTMLElement = (tagName) => document.createElement(tagName),
): Promise<{ bodyElement: HTMLElement; styleElement: HTMLElement }> {
  const bodyElement = createElement("div");
  const styleElement = createElement("div");
  await render(blob, bodyElement, styleElement, DOCX_PREVIEW_OPTIONS);
  return { bodyElement, styleElement };
}

export function DocxPreviewPane({ assetUrl, title }: DocxPreviewPaneProps) {
  const { t } = useTranslation("files");
  const bodyRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const renderTokenRef = useRef(0);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    const bodyElement = bodyRef.current;
    const styleElement = styleRef.current;
    if (!bodyElement || !styleElement) {
      return;
    }

    const abortController = new AbortController();
    let resizeObserver: ResizeObserver | null = null;
    let rafId = 0;
    const dirtyPages = new Set<HTMLElement>();
    let containerDirty = false;
    const renderToken = renderTokenRef.current + 1;
    let active = true;
    renderTokenRef.current = renderToken;

    const isCurrentRender = () => active && renderTokenRef.current === renderToken;

    bodyElement.innerHTML = "";
    styleElement.innerHTML = "";
    setStatus("loading");

    const disconnectResizeObserver = () => {
      resizeObserver?.disconnect();
      resizeObserver = null;
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = 0;
      }
      dirtyPages.clear();
      containerDirty = false;
    };

    const renderDocument = async () => {
      try {
        const response = await fetch(assetUrl, { signal: abortController.signal });
        if (!response.ok) {
          throw new Error(`Failed to fetch DOCX asset: ${response.status}`);
        }

        const blob = await response.blob();
        if (!active) {
          return;
        }

        const rendered = await renderDocxPreviewDetached(blob);
        sanitizeDocxPreviewLinks(rendered.bodyElement);

        if (!isCurrentRender()) {
          return;
        }

        bodyElement.replaceChildren(...Array.from(rendered.bodyElement.childNodes));
        styleElement.replaceChildren(...Array.from(rendered.styleElement.childNodes));
        const pages = wrapDocxPreviewPages(bodyElement);
        resizeDocxPreviewPages(bodyElement, pages);

        if (typeof ResizeObserver !== "undefined") {
          const flush = () => {
            rafId = 0;
            if (!isCurrentRender()) {
              return;
            }
            const targets = containerDirty
              ? Array.from(bodyElement.querySelectorAll<HTMLElement>(DOCX_PREVIEW_PAGE_SELECTOR))
              : Array.from(dirtyPages);
            dirtyPages.clear();
            containerDirty = false;
            resizeDocxPreviewPages(bodyElement, targets);
          };

          resizeObserver = new ResizeObserver((entries) => {
            for (const entry of entries) {
              if (entry.target === bodyElement) {
                containerDirty = true;
              } else {
                dirtyPages.add(entry.target as HTMLElement);
              }
            }
            if (!rafId) {
              rafId = requestAnimationFrame(flush);
            }
          });
          resizeObserver.observe(bodyElement);
          for (const page of pages) {
            resizeObserver.observe(page);
          }
        }

        setStatus("ready");
      } catch (error) {
        if (abortController.signal.aborted || !isCurrentRender()) {
          return;
        }

        console.error("Failed to render DOCX preview:", error);
        bodyElement.innerHTML = "";
        styleElement.innerHTML = "";
        setStatus("error");
      }
    };

    void renderDocument();

    return () => {
      active = false;
      abortController.abort();
      disconnectResizeObserver();
      bodyElement.innerHTML = "";
      styleElement.innerHTML = "";
    };
  }, [assetUrl]);

  return (
    <div className="docx-preview-pane relative h-full overflow-auto bg-surface" aria-label={title}>
      <style>{DOCX_PREVIEW_LAYOUT_CSS}</style>
      <div ref={styleRef} aria-hidden="true" />
      <div ref={bodyRef} className="docx-preview-pages" />
      {status !== "ready" && (
        <div className="absolute inset-0 flex items-center justify-center bg-surface/80 p-6">
          <div className="max-w-md text-center">
            {status === "loading" ? (
              <p className="text-ui text-subtle-foreground">{t("view.loadingDocument")}</p>
            ) : (
              <>
                <h3 className="text-section text-foreground">
                  {t("view.documentPreviewFailedTitle")}
                </h3>
                <p className="mt-2 text-ui text-muted-foreground">
                  {t("view.documentPreviewFailedDescription")}
                </p>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
