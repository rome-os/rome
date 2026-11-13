import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Zoom from "react-medium-image-zoom";
import "./composer/pending-image-preview.css";
import { useDesktop } from "@/hooks/use-desktop";
import { mediaKindOfSrc, thumbnailSrc } from "@/lib/asset-links";
import { cn } from "@/lib/utils";
import { FileChip } from "./FileChip";
import { ImagePreviewContent, type PreviewContentProps } from "./composer/ImagePreviewContent";

const NoGlyph = () => null;

/**
 * True inside a Markdown link. A tap on a linked picture belongs to the link,
 * so the picture does not open the viewer there.
 */
export const InsideLinkContext = createContext(false);

// A picture on this instance's asset routes loads as a thumbnail this wide.
// The viewer and Download use the original.
const THUMBNAIL_WIDTH = 900;

// Space around an open picture. A phone gives it little, so a picture as wide
// as the column still opens larger than its thumbnail.
const VIEWER_MARGIN_WIDE = 64;
const VIEWER_MARGIN_PHONE = 16;

/**
 * Opens its picture in the viewer on a tap. `src` is the original, which the
 * viewer swaps in and Download saves; `thumbnail` is what `children` shows.
 * The viewer's component is stable for one picture, so a streaming re-render
 * does not remount an open viewer. It downloads the original even while the
 * viewer still shows the thumbnail.
 */
export function ZoomableImage({
  src,
  alt,
  thumbnail,
  children,
}: {
  src: string;
  alt?: string;
  thumbnail: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("chat");
  const desktop = useDesktop();
  const ZoomContent = useMemo(
    () =>
      function ReplyImagePreviewContent(props: PreviewContentProps) {
        return <ImagePreviewContent {...props} inReply downloadSrc={src} />;
      },
    [src],
  );
  return (
    <Zoom
      a11yNameButtonZoom={t("composer.previewImage")}
      a11yNameButtonUnzoom={t("composer.closeImagePreview")}
      classDialog="pending-image-preview"
      IconZoom={NoGlyph}
      IconUnzoom={X}
      ZoomContent={ZoomContent}
      zoomImg={thumbnail === src ? undefined : { src, alt }}
      canSwipeToUnzoom={false}
      zoomMargin={desktop ? VIEWER_MARGIN_WIDE : VIEWER_MARGIN_PHONE}
    >
      {children}
    </Zoom>
  );
}

type ChatImageProps = ComponentPropsWithoutRef<"img"> & {
  node?: unknown;
  /** Replaces the wrapper's vertical margin, for a picture that sits in a row. */
  wrapperClassName?: string;
};

/**
 * A video or audio file in a chat message, with the browser's own controls.
 * Only its metadata loads until it plays. One that cannot be played, because
 * of a codec the browser lacks or a failed load, becomes a chip for the file,
 * so it can still be saved.
 */
export function ChatMedia({
  src,
  kind,
  label,
}: {
  src: string;
  kind: "video" | "audio";
  label?: string;
}) {
  const [failed, setFailed] = useState(false);
  const name = label || src.split(/[?#]/)[0]?.split("/").at(-1) || src;
  return (
    <div data-streamdown="media-wrapper" className="my-4 inline-block max-w-full">
      {failed ? (
        <FileChip href={src} label={name} />
      ) : kind === "video" ? (
        <video
          controls
          preload="metadata"
          src={src}
          aria-label={label}
          className="h-auto max-h-72 w-auto max-w-full rounded-8"
          onError={() => setFailed(true)}
        >
          {label}
        </video>
      ) : (
        <audio
          controls
          preload="metadata"
          src={src}
          aria-label={label}
          className="w-72 max-w-full"
          onError={() => setFailed(true)}
        >
          {label}
        </audio>
      )}
    </div>
  );
}

/**
 * A picture in a chat message, on a line of its own: text in the same Markdown
 * paragraph sits above or below it, never beside it. A tap opens the viewer,
 * which can also download it. Inside a link, the tap follows the link instead. The wrapper and image
 * keep Streamdown's `data-streamdown` hooks, so the kit's block spacing applies.
 * A picture that fails to load shows a line of text, not a broken icon.
 */
export function ChatImage({
  node: _node,
  src,
  alt,
  className,
  wrapperClassName,
  onError,
  ...props
}: ChatImageProps) {
  const { t } = useTranslation("chat");
  const [failedSrc, setFailedSrc] = useState<string>();
  const insideLink = useContext(InsideLinkContext);
  if (!src) return null;
  const media = mediaKindOfSrc(src);
  if (media) return <ChatMedia src={src} kind={media} label={alt} />;
  const thumbnail = thumbnailSrc(src, THUMBNAIL_WIDTH);

  const image = (
    <img
      {...props}
      src={thumbnail}
      alt={alt}
      data-streamdown="image"
      className={cn("h-auto max-h-72 w-auto max-w-full rounded-8 object-contain", className)}
      onError={(event) => {
        setFailedSrc(src);
        onError?.(event);
      }}
    />
  );

  return (
    <div
      data-streamdown="image-wrapper"
      className={cn("my-4 block w-fit max-w-full", wrapperClassName)}
    >
      {failedSrc === src ? (
        <span
          data-streamdown="image-fallback"
          title={alt}
          className="text-ui italic text-muted-foreground"
        >
          {t("markdown.imageNotAvailable")}
        </span>
      ) : insideLink ? (
        image
      ) : (
        <ZoomableImage src={src} alt={alt} thumbnail={thumbnail}>
          {image}
        </ZoomableImage>
      )}
    </div>
  );
}
