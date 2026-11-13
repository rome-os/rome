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
import type { ReplyPicture } from "@/lib/reply-pictures";

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
   * place among them. Read when the viewer opens and again at each page turn.
   * With two or more, the viewer pages between them.
   */
  pictures?: () => { pictures: ReplyPicture[]; index: number };
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
  // The set of pictures as read when the viewer opened. `opened` is the one
  // whose image the viewer grew from, and it is the one that shows through the
  // library's own image. Every other page is drawn here from its original.
  const [set, setSet] = useState<{ pictures: ReplyPicture[]; opened: number }>({
    pictures: [],
    opened: 0,
  });
  const [index, setIndex] = useState(0);
  const read = useRef(readPictures);
  read.current = readPictures;
  const swipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const paging = inReply && set.pictures.length >= 2;
  const paged = paging && index !== set.opened;
  const current = paging ? set.pictures[index] : undefined;
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

  useEffect(() => {
    if (modalState !== "LOADING" || !read.current) return;
    const { pictures, index: opened } = read.current();
    setSet({ pictures, opened });
    setIndex(opened);
  }, [modalState]);

  // The neighbours load before they are asked for.
  useEffect(() => {
    if (!paging) return;
    for (const neighbour of [index - 1, index + 1]) {
      const src = set.pictures[neighbour]?.src;
      if (src) new Image().src = src;
    }
  }, [paging, index, set]);

  /** Pages by `delta`, stopping at the first and the last picture. */
  const go = (delta: number) => {
    // A message that streamed since the viewer opened may have more pictures.
    const fresh = read.current?.();
    const pictures = fresh && fresh.pictures.length > 0 ? fresh.pictures : set.pictures;
    const opened = fresh && fresh.pictures.length > 0 ? fresh.index : set.opened;
    const next = index + delta;
    if (next < 0 || next >= pictures.length) return;
    setSet({ pictures, opened });
    setIndex(next);
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
      onKeyDown={(event) => {
        if (!active) return;
        if (event.key === "+" || event.key === "=") {
          event.preventDefault();
          changeScale(SCALE_STEP);
        } else if (event.key === "-") {
          event.preventDefault();
          changeScale(-SCALE_STEP);
        } else if (event.key === "0") {
          event.preventDefault();
          reset();
        } else if (paging && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
          event.preventDefault();
          go(event.key === "ArrowLeft" ? -1 : 1);
        }
      }}
      onPointerDown={(event) => {
        if (paging && active && scale === MIN_SCALE && event.pointerType === "touch") {
          swipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
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
      onPointerCancel={() => {
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
            {t("composer.imageCounter", { current: index + 1, total: set.pictures.length })}
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
            disabled={!active || index === set.pictures.length - 1}
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
