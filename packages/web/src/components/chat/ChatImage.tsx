import { useState, type ComponentPropsWithoutRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import Zoom from "react-medium-image-zoom";
import "./composer/pending-image-preview.css";
import { cn } from "@/lib/utils";
import { ImagePreviewContent, type PreviewContentProps } from "./composer/ImagePreviewContent";

const NoGlyph = () => null;

// A module-level component keeps the viewer's identity stable, so a streaming
// re-render does not remount an open picture.
function ReplyImagePreviewContent(props: PreviewContentProps) {
  return <ImagePreviewContent {...props} inReply />;
}

type ChatImageProps = ComponentPropsWithoutRef<"img"> & { node?: unknown };

/**
 * A picture in a chat message. A tap opens the viewer, which can also download
 * it. The wrapper and image keep Streamdown's `data-streamdown` hooks, so the
 * kit's block spacing applies. A picture that fails to load shows a line of
 * text, not a broken icon.
 */
export function ChatImage({ node: _node, src, alt, className, onError, ...props }: ChatImageProps) {
  const { t } = useTranslation("chat");
  const [failedSrc, setFailedSrc] = useState<string>();
  if (!src) return null;

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
      ) : (
        <Zoom
          a11yNameButtonZoom={t("composer.previewImage")}
          a11yNameButtonUnzoom={t("composer.closeImagePreview")}
          classDialog="pending-image-preview"
          IconZoom={NoGlyph}
          IconUnzoom={X}
          ZoomContent={ReplyImagePreviewContent}
          canSwipeToUnzoom={false}
          zoomMargin={64}
        >
          <img
            {...props}
            src={src}
            alt={alt}
            data-streamdown="image"
            className={cn("h-auto max-h-72 w-auto max-w-full rounded-8 object-contain", className)}
            onError={(event) => {
              setFailedSrc(src);
              onError?.(event);
            }}
          />
        </Zoom>
      )}
    </div>
  );
}
