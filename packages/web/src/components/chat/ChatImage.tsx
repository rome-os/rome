import { createContext, useContext, useMemo, useState, type ComponentPropsWithoutRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Zoom from "react-medium-image-zoom";
import "./composer/pending-image-preview.css";
import { useDesktop } from "@/hooks/use-desktop";
import { cn } from "@/lib/utils";
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
const ASSET_SRC = /^\/api\/(?:(?:projects|memory)\/asset(?:[/?]|$)|assets\/)/;

// Space around an open picture. A phone gives it little, so a picture as wide
// as the column still opens larger than its thumbnail.
const VIEWER_MARGIN_WIDE = 64;
const VIEWER_MARGIN_PHONE = 16;

/** `src` asking the server for a thumbnail, or `src` itself when it is not an asset route. */
function thumbnailSrc(src: string): string {
  if (!ASSET_SRC.test(src) || /[?&]w=/.test(src)) return src;
  const hashAt = src.indexOf("#");
  const path = hashAt < 0 ? src : src.slice(0, hashAt);
  const hash = hashAt < 0 ? "" : src.slice(hashAt);
  return `${path}${path.includes("?") ? "&" : "?"}w=${THUMBNAIL_WIDTH}${hash}`;
}

type ChatImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/**
 * A picture in a chat message. A tap opens the viewer, which can also download
 * it. Inside a link, the tap follows the link instead. The wrapper and image
 * keep Streamdown's `data-streamdown` hooks, so the kit's block spacing applies.
 * A picture that fails to load shows a line of text, not a broken icon.
 */
export function ChatImage({ node: _node, src, alt, className, onError, ...props }: ChatImageProps) {
  const { t } = useTranslation("chat");
  const [failedSrc, setFailedSrc] = useState<string>();
  const insideLink = useContext(InsideLinkContext);
  const desktop = useDesktop();
  // The viewer's component is stable for one picture, so a streaming re-render
  // does not remount an open viewer. It downloads the original even while the
  // viewer still shows the thumbnail.
  const ZoomContent = useMemo(
    () =>
      function ReplyImagePreviewContent(props: PreviewContentProps) {
        return <ImagePreviewContent {...props} inReply downloadSrc={src} />;
      },
    [src],
  );
  if (!src) return null;
  const thumbnail = thumbnailSrc(src);

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
    <div data-streamdown="image-wrapper" className="my-4 inline-block max-w-full">
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
          {image}
        </Zoom>
      )}
    </div>
  );
}
