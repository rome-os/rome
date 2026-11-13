import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactElement,
} from "react";
import { ChevronLeft, ChevronRight, Download, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ControlledProps } from "react-medium-image-zoom";
import { cn } from "@/lib/utils";
import { IconButton } from "@/components/ui/icon-button";
import { useDesktop } from "@/hooks/use-desktop";
import {
  placeOf,
  type ReplyPicture,
  samePictures,
  VIEWER_PICTURE_ATTR,
} from "@/lib/reply-pictures";

export type PreviewContentProps = Parameters<NonNullable<ControlledProps["ZoomContent"]>>[0];
type ModalImage = ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;
// A swipe pages when it moves this far sideways, and mostly sideways.
const SWIPE_DISTANCE = 50;
const SWIPE_RATIO = 1.5;

/**
 * Space around an open picture. A phone gives it little, so a picture as wide
 * as the column still opens larger than its thumbnail.
 */
export function viewerMargin(desktop: boolean): number {
  return desktop ? 64 : 16;
}

export type ImagePreviewContentProps = PreviewContentProps & {
  /**
   * The picture is one in a chat reply, not a composer preview. A reply picture
   * has a Download button and opens from its own shape. A composer preview is a
   * blob of what was just picked, in a square card, so it has neither.
   */
  inReply?: boolean;
  /** What Download saves, when it is not the viewer's own image: the original of a thumbnail. */
  downloadSrc?: string;
  /**
   * The pictures of the picture's message that open a viewer, and this one's
   * place among them, and the message's root. Read when the viewer opens, and
   * again whenever the root's pictures change while it is open. With two or
   * more, the viewer pages between them.
   */
  pictures?: () => { pictures: ReplyPicture[]; index: number; root: Element | null };
};

/**
 * Saves the picture at `src`. A same-origin file downloads through a link. A
 * picture from another origin opens in a new tab, because a link's `download`
 * ignores it and a fetch needs the host's CORS consent. Both run inside the
 * tap, since Safari blocks a tab opened after an `await`.
 */
export function downloadImage(src: string) {
  try {
    const url = new URL(src, window.location.href);
    if (url.origin === window.location.origin) {
      const link = document.createElement("a");
      link.href = url.href;
      link.download = decodeURIComponent(url.pathname.split("/").pop() ?? "") || "image";
      link.click();
      return;
    }
  } catch {
    // A URL that does not parse opens as it is.
  }
  window.open(src, "_blank", "noopener,noreferrer");
}

export function ImagePreviewContent({
  img,
  modalState,
  onUnzoom,
  inReply = false,
  downloadSrc,
  pictures: readPictures,
}: ImagePreviewContentProps) {
  const { t } = useTranslation("chat");
  const desktop = useDesktop();
  // The pictures of the message, kept in step with it while the viewer is open.
  // The page shown is found in them by its address, so a list that grows or
  // shrinks under the viewer never skips or repeats a picture. `hint` is the
  // last place it was found, for a picture listed twice.
  const [group, setGroup] = useState<ReplyPicture[]>([]);
  const [view, setView] = useState({ src: "", hint: 0 });
  const read = useRef(readPictures);
  read.current = readPictures;
  const swipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  // The fingers down on the viewer. A second one ends the swipe, and no swipe
  // starts again until every finger is up.
  const touches = useRef(new Set<number>());
  const multiTouch = useRef(false);
  const paging = inReply && group.length >= 2;
  const index = paging ? placeOf(group, view.src, view.hint) : 0;
  const current = paging ? group[index] : undefined;
  // Only the picture the viewer grew from shows through the library's own
  // image. Every other page is drawn here from its original.
  const paged = paging && current?.src !== downloadSrc;
  const [scale, setScale] = useState(MIN_SCALE);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const viewport = useRef<HTMLDivElement>(null);
  const suppressBackdropClick = useRef(false);
  const drag = useRef<{
    pointerId: number;
    x: number;
    y: number;
    panX: number;
    panY: number;
  } | null>(null);

  const reset = () => {
    setScale(MIN_SCALE);
    setPan({ x: 0, y: 0 });
  };
  const changeScale = (delta: number) => {
    setScale((current) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, current + delta)));
    setPan({ x: 0, y: 0 });
  };

  const viewerOpen = modalState !== "UNLOADED";
  useEffect(() => {
    if (!viewerOpen || !read.current) return;
    touches.current.clear();
    multiTouch.current = false;
    const first = read.current();
    setGroup(first.pictures);
    setView({ src: first.pictures[first.index]?.src ?? "", hint: first.index });
    if (!first.root) return;
    // A message that streams while the viewer is open gains pictures, and one
    // may fail to load and leave. Read the root again whenever its marks move.
    const observer = new MutationObserver(() => {
      const next = read.current?.().pictures;
      if (!next) return;
      setGroup((prev) => (samePictures(prev, next) ? prev : next));
      setView((prev) => {
        const at = placeOf(next, prev.src, prev.hint);
        const src = next[at]?.src ?? prev.src;
        return src === prev.src && at === prev.hint ? prev : { src, hint: at };
      });
    });
    observer.observe(first.root, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: [VIEWER_PICTURE_ATTR, "data-viewer-src"],
    });
    return () => observer.disconnect();
  }, [viewerOpen]);

  // The neighbours load before they are asked for.
  useEffect(() => {
    if (!paging) return;
    for (const neighbour of [index - 1, index + 1]) {
      const src = group[neighbour]?.src;
      if (src) new Image().src = src;
    }
  }, [paging, index, group]);

  /** Pages by `delta`, stopping at the first and the last picture. */
  const go = (delta: number) => {
    // Read the message again, so the step starts from what it holds now.
    const pictures = read.current?.().pictures ?? group;
    const at = placeOf(pictures, view.src, view.hint);
    const next = at + delta;
    if (at < 0 || next < 0 || next >= pictures.length) return;
    setGroup((prev) => (samePictures(prev, pictures) ? prev : pictures));
    setView({ src: pictures[next]?.src ?? "", hint: next });
    reset();
  };

  useEffect(() => {
    if (modalState === "UNLOADED") {
      setScale(MIN_SCALE);
      setPan({ x: 0, y: 0 });
      drag.current = null;
    }
  }, [modalState]);

  const active = modalState === "LOADED";

  // Keys go through the document, as the library's Escape does. A focused button
  // that turns disabled at the end of the pictures hands its focus to the page,
  // and a key handler on the viewer would then hear nothing.
  const onKey = useRef<(event: KeyboardEvent) => void>(() => {});
  onKey.current = (event) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      (target.isContentEditable || target.matches("input, textarea, select"))
    ) {
      return;
    }
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      changeScale(SCALE_STEP);
    } else if (event.key === "-") {
      event.preventDefault();
      changeScale(-SCALE_STEP);
    } else if (event.key === "0") {
      event.preventDefault();
      reset();
    } else if (
      paging &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      go(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  useEffect(() => {
    if (!active) return;
    const listener = (event: KeyboardEvent) => onKey.current(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, [active]);

  const image = modalImage(img);
  // Download saves the original of the picture shown, never a thumbnail.
  const saveSrc = paged ? current?.src : (downloadSrc ?? image?.props.src);
  return (
    <div
      ref={viewport}
      className={cn("absolute inset-0 overflow-clip", paging && "touch-none")}
      data-preview-state={modalState}
      data-preview-pannable={active && scale > MIN_SCALE}
      onClick={(event) => {
        event.stopPropagation();
        if (suppressBackdropClick.current) {
          suppressBackdropClick.current = false;
          return;
        }
        if (event.target === event.currentTarget) onUnzoom(event.nativeEvent);
      }}
      onWheel={(event) => {
        // The viewer's default window listener closes on wheel events.
        event.stopPropagation();
        if (active && !event.ctrlKey && event.deltaY !== 0) {
          changeScale(event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP);
        }
      }}
      onPointerDown={(event) => {
        if (event.pointerType === "touch") {
          touches.current.add(event.pointerId);
          if (touches.current.size > 1) {
            // A second finger is a pinch, not a swipe.
            multiTouch.current = true;
            swipe.current = null;
          } else if (!multiTouch.current && paging && active && scale === MIN_SCALE) {
            swipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
          }
        }
        if (!active || scale === MIN_SCALE || event.button !== 0) return;
        if (!(event.target instanceof HTMLImageElement)) return;
        event.preventDefault();
        suppressBackdropClick.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = {
          pointerId: event.pointerId,
          x: event.clientX,
          y: event.clientY,
          panX: pan.x,
          panY: pan.y,
        };
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        const image =
          viewport.current?.querySelector("img[data-preview-current]") ??
          viewport.current?.querySelector("img");
        if (!start || start.pointerId !== event.pointerId || !image || !viewport.current) return;
        const imageBounds = image.getBoundingClientRect();
        const bounds = viewport.current.getBoundingClientRect();
        const limitX = Math.max(0, (imageBounds.width - bounds.width) / 2 + 32);
        const limitY = Math.max(0, (imageBounds.height - bounds.height) / 2 + 32);
        setPan({
          x: Math.max(-limitX, Math.min(limitX, start.panX + event.clientX - start.x)),
          y: Math.max(-limitY, Math.min(limitY, start.panY + event.clientY - start.y)),
        });
      }}
      onPointerUp={(event) => {
        if (event.pointerType === "touch") {
          touches.current.delete(event.pointerId);
          if (touches.current.size === 0) multiTouch.current = false;
        }
        const start = swipe.current;
        if (start?.pointerId === event.pointerId) {
          swipe.current = null;
          const dx = event.clientX - start.x;
          const dy = event.clientY - start.y;
          if (
            scale === MIN_SCALE &&
            Math.abs(dx) > SWIPE_DISTANCE &&
            Math.abs(dx) > SWIPE_RATIO * Math.abs(dy)
          ) {
            go(dx < 0 ? 1 : -1);
            return;
          }
        }
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={(event) => {
        if (event.pointerType === "touch") {
          touches.current.delete(event.pointerId);
          if (touches.current.size === 0) multiTouch.current = false;
        }
        swipe.current = null;
        drag.current = null;
        suppressBackdropClick.current = false;
      }}
    >
      <div
        data-preview-transform
        className="pointer-events-none absolute inset-0 [&_img]:pointer-events-auto [&_img]:touch-none [&_img]:select-none"
        style={{
          transform: active
            ? `translate(${pan.x}px, ${pan.y}px) scale(${scale})`
            : "translate(0px, 0px) scale(1)",
        }}
        onDragStart={(event) => event.preventDefault()}
      >
        {image &&
          (inReply
            ? cloneElement(image, {
                "data-preview-current": paged ? undefined : "",
                // The library's image keeps its place, hidden, so the viewer
                // still closes on its transition.
                style: { ...image.props.style, visibility: paged ? "hidden" : undefined },
              } as ImgHTMLAttributes<HTMLImageElement>)
            : clipToThumbnail(image, modalState))}
        {paged && current && (
          <div
            className="absolute flex items-center justify-center"
            style={{ inset: viewerMargin(desktop) }}
          >
            <img
              key={`${index}:${current.src}`}
              data-preview-current=""
              src={current.src}
              alt={current.alt}
              draggable={false}
              className={cn(
                "max-h-full max-w-full object-contain transition-opacity",
                modalState === "UNLOADING" ? "opacity-0" : "opacity-100",
              )}
              // The page leaves with the backdrop, not back to a thumbnail it
              // did not come from.
              style={{ transitionDuration: "var(--preview-return-duration, 280ms)" }}
            />
          </div>
        )}
      </div>
      {/* Close comes first in the DOM, so it keeps the viewer's initial focus. */}
      <div className="absolute right-4 top-4 flex flex-row-reverse gap-2">
        <IconButton
          data-preview-controls
          label={t("composer.closeImagePreview")}
          icon={<X aria-hidden />}
          onClick={(event) => onUnzoom(event.nativeEvent)}
          disabled={modalState === "UNLOADING"}
          className="rounded-full border-border bg-surface shadow-sm"
        />
        {inReply && saveSrc && (
          <IconButton
            data-preview-controls
            label={t("composer.downloadImage")}
            icon={<Download aria-hidden />}
            onClick={() => downloadImage(saveSrc)}
            disabled={modalState === "UNLOADING"}
            className="rounded-full border-border bg-surface shadow-sm"
          />
        )}
      </div>
      {paging && (
        <>
          <output
            data-preview-controls
            aria-live="polite"
            className="absolute left-4 top-4 flex h-[var(--control-h-md)] items-center rounded-full border border-border bg-surface px-3 text-ui tabular-nums text-foreground shadow-sm"
          >
            {t("composer.imageCounter", { current: index + 1, total: group.length })}
          </output>
          <IconButton
            data-preview-controls
            label={t("composer.previousImage")}
            icon={<ChevronLeft aria-hidden />}
            onClick={() => go(-1)}
            disabled={!active || index === 0}
            className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full border-border bg-surface shadow-sm"
          />
          <IconButton
            data-preview-controls
            label={t("composer.nextImage")}
            icon={<ChevronRight aria-hidden />}
            onClick={() => go(1)}
            disabled={!active || index === group.length - 1}
            className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full border-border bg-surface shadow-sm"
          />
        </>
      )}
      <div
        data-preview-controls
        className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full border border-border bg-surface p-2 text-foreground shadow-sm"
      >
        <IconButton
          label={t("composer.zoomOut")}
          icon={<ZoomOut aria-hidden />}
          disabled={!active || scale === MIN_SCALE}
          onClick={() => changeScale(-SCALE_STEP)}
        />
        <output
          className="min-w-12 text-center text-ui tabular-nums"
          aria-label={t("composer.zoomLevel")}
        >
          {Math.round(scale * 100)}%
        </output>
        <IconButton
          label={t("composer.zoomIn")}
          icon={<ZoomIn aria-hidden />}
          disabled={!active || scale === MAX_SCALE}
          onClick={() => changeScale(SCALE_STEP)}
        />
        <IconButton
          label={t("composer.resetZoom")}
          icon={<RotateCcw aria-hidden />}
          disabled={!active || scale === MIN_SCALE}
          onClick={reset}
        />
      </div>
    </div>
  );
}

export function modalImage(img: PreviewContentProps["img"]): ModalImage | null {
  return isValidElement<ImgHTMLAttributes<HTMLImageElement>>(img) ? img : null;
}

/**
 * The viewer's image, cropped to its card's centered square with the card's
 * 8px radius at 96px whenever it is not fully open, so it leaves and returns
 * as the thumbnail the guardian clicked rather than as the full frame.
 */
export function clipToThumbnail(image: ModalImage, modalState: PreviewContentProps["modalState"]) {
  const width = Number(image.props.style?.width) || 1;
  const height = Number(image.props.style?.height) || 1;
  const side = Math.min(width, height);
  const insetX = ((width - side) / width) * 50;
  const insetY = ((height - side) / height) * 50;
  const thumbnailClip = `inset(${insetY}% ${insetX}% round ${(side / width) * (100 / 12)}% / ${(side / height) * (100 / 12)}%)`;
  return cloneElement(image, {
    style: {
      ...image.props.style,
      clipPath:
        modalState === "LOADING" || modalState === "LOADED"
          ? "inset(0% 0% round 0% / 0%)"
          : thumbnailClip,
    },
    onTransitionEnd: (event) => {
      // The clip transitions too, and only the transform's end tells the
      // viewer the move is over.
      if (event.propertyName === "transform") image.props.onTransitionEnd?.(event);
    },
  });
}
