import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type ImgHTMLAttributes,
  type ReactElement,
} from "react";
import { RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ControlledProps } from "react-medium-image-zoom";
import { IconButton } from "@/components/ui/icon-button";

export type PreviewContentProps = Parameters<NonNullable<ControlledProps["ZoomContent"]>>[0];
type ModalImage = ReactElement<ImgHTMLAttributes<HTMLImageElement>>;
const MIN_SCALE = 1;
const MAX_SCALE = 4;
const SCALE_STEP = 0.25;

export function ImagePreviewContent({ img, modalState, onUnzoom }: PreviewContentProps) {
  const { t } = useTranslation("chat");
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
    if (modalState === "UNLOADED") {
      setScale(MIN_SCALE);
      setPan({ x: 0, y: 0 });
      drag.current = null;
    }
  }, [modalState]);

  const active = modalState === "LOADED";
  const image = modalImage(img);
  return (
    <div
      ref={viewport}
      className="absolute inset-0 overflow-clip"
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
        }
      }}
      onPointerDown={(event) => {
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
        const image = viewport.current?.querySelector("img");
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
        if (drag.current?.pointerId !== event.pointerId) return;
        drag.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
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
        {image && clipToThumbnail(image, modalState)}
      </div>
      <IconButton
        data-preview-controls
        label={t("composer.closeImagePreview")}
        icon={<X aria-hidden />}
        onClick={(event) => onUnzoom(event.nativeEvent)}
        disabled={modalState === "UNLOADING"}
        className="absolute right-4 top-4 rounded-full border-border bg-surface shadow-sm"
      />
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
