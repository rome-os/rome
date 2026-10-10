import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { IconButton } from "@/components/ui/icon-button";
import { clipToThumbnail, modalImage, type PreviewContentProps } from "./ImagePreviewContent";

/**
 * The video viewer. The poster travels between the card and the viewer like an
 * image does, and once it lands a playing `<video>` takes its exact box. Leaving
 * unmounts the video, which stops playback, and the poster carries the return.
 */
export function VideoPreviewContent({
  img,
  modalState,
  onUnzoom,
  src,
}: PreviewContentProps & { src: string }) {
  const { t } = useTranslation("chat");
  const image = modalImage(img);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    // Focus puts the player's own keys (space, arrows) in reach at once.
    if (modalState === "LOADED") video.current?.focus({ preventScroll: true });
  }, [modalState]);

  return (
    <div
      className="absolute inset-0 overflow-clip"
      data-preview-state={modalState}
      onClick={(event) => {
        // The dialog closes on any click, which would include the player's
        // own controls.
        event.stopPropagation();
        if (event.target === event.currentTarget) onUnzoom(event.nativeEvent);
      }}
      // The viewer's default window listener closes on wheel events, and a
      // scroll over a playing video is not a request to leave.
      onWheel={(event) => event.stopPropagation()}
    >
      {image && clipToThumbnail(image, modalState)}
      {image && modalState === "LOADED" ? (
        // At rest the poster's transform is a translation at scale 1, so its
        // style places the player at full size with native-size controls.
        <video
          data-preview-video
          src={src}
          poster={image.props.src}
          controls
          autoPlay
          playsInline
          ref={video}
          style={image.props.style}
          className="absolute origin-top-left object-contain outline-1 outline-offset-0 outline-transparent focus-visible:outline-solid focus-visible:outline-ring/50"
        />
      ) : null}
      <IconButton
        data-preview-controls
        label={t("composer.closeImagePreview")}
        icon={<X aria-hidden />}
        onClick={(event) => onUnzoom(event.nativeEvent)}
        disabled={modalState === "UNLOADING"}
        className="absolute right-4 top-4 rounded-full border-border bg-surface shadow-sm"
      />
    </div>
  );
}
