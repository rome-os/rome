import { useState } from "react";
import { useTranslation } from "react-i18next";
import { thumbnailSrc } from "@/lib/asset-links";
import type { Picture, PictureSet } from "@/lib/picture-set";
import { cn } from "@/lib/utils";
import { ZoomableImage } from "./ChatImage";

// A picture on this instance's asset routes loads as a thumbnail this wide.
// The viewer and Download use the original.
const TILE_WIDTH = 600;

const FRAME_CLASS = "block w-full rounded-12 bg-surface-muted object-cover";
const GRID_ASPECT = "aspect-[4/3]";
// Fixed width, so every row of a list lines its text up.
const LIST_ASPECT = "aspect-[3/4]";
const LIST_WIDTH = "w-35 shrink-0 md:w-45";

/**
 * One picture of a set: the picture in its frame, which opens the viewer on a
 * tap, with the host of an outside picture on its corner. A picture that fails
 * to load leaves the same frame holding "Image not available", so the layout
 * keeps its shape.
 */
function PictureFrame({
  picture,
  aspect,
  className,
}: {
  picture: Picture;
  aspect: string;
  className?: string;
}) {
  const { t } = useTranslation("chat");
  const [failedSrc, setFailedSrc] = useState<string>();
  const thumbnail = thumbnailSrc(picture.src, TILE_WIDTH);
  const failed = failedSrc === picture.src;
  return (
    <div className={cn("relative min-w-0", className)}>
      {failed ? (
        <div
          data-picture-fallback
          title={picture.title}
          className={cn(
            FRAME_CLASS,
            aspect,
            "flex items-center justify-center p-2 text-center text-ui italic text-muted-foreground",
          )}
        >
          {t("markdown.imageNotAvailable")}
        </div>
      ) : (
        <ZoomableImage src={picture.src} alt={picture.title} thumbnail={thumbnail}>
          <img
            src={thumbnail}
            alt={picture.title}
            loading="lazy"
            decoding="async"
            className={cn(FRAME_CLASS, aspect)}
            onError={() => setFailedSrc(picture.src)}
          />
        </ZoomableImage>
      )}
      {picture.host ? (
        <span
          data-picture-source
          className="pointer-events-none absolute bottom-2 left-2 max-w-[calc(100%-1rem)] truncate rounded-4 bg-surface/90 px-2 text-aux text-foreground"
        >
          {picture.host}
        </span>
      ) : null}
    </div>
  );
}

function GridTile({ picture }: { picture: Picture }) {
  return (
    <figure data-picture className="m-0 flex min-w-0 flex-col gap-2">
      <PictureFrame picture={picture} aspect={GRID_ASPECT} />
      {picture.title || picture.note ? (
        <figcaption className="flex min-w-0 flex-col gap-1">
          {picture.title ? (
            <span className="line-clamp-2 break-words text-section text-foreground">
              {picture.title}
            </span>
          ) : null}
          {picture.note ? (
            <span className="line-clamp-2 break-words text-aux text-muted-foreground">
              {picture.note}
            </span>
          ) : null}
        </figcaption>
      ) : null}
    </figure>
  );
}

function ListRow({ picture }: { picture: Picture }) {
  return (
    <figure data-picture role="listitem" className="m-0 flex min-w-0 items-start gap-3">
      <PictureFrame picture={picture} aspect={LIST_ASPECT} className={LIST_WIDTH} />
      <figcaption className="flex min-w-0 flex-1 flex-col gap-1">
        {picture.title ? (
          <span className="break-words text-section text-foreground">{picture.title}</span>
        ) : null}
        {picture.note ? (
          <span className="break-words text-ui text-muted-foreground">{picture.note}</span>
        ) : null}
      </figcaption>
    </figure>
  );
}

/**
 * The pictures of a ```pictures fence in a chat reply, as a two-column grid of
 * 4:3 tiles or as a list of rows with the picture on the left. Each key holds
 * the picture's place and address, so a set that grows while a reply streams
 * keeps the tiles it has, and an open viewer stays mounted.
 */
export function ChatPictureSet({ set }: { set: PictureSet }) {
  const list = set.layout === "list";
  return (
    <div
      // The kit spaces this like a single picture in a reply.
      data-streamdown="image-wrapper"
      data-chat-picture-set={set.layout}
      role={list ? "list" : "group"}
      className={cn(
        "min-w-0",
        list
          ? "flex flex-col gap-4"
          : cn("grid gap-3", set.pictures.length === 1 ? "grid-cols-1" : "grid-cols-2"),
      )}
    >
      {set.pictures.map((picture, index) =>
        list ? (
          <ListRow key={`${index}:${picture.src}`} picture={picture} />
        ) : (
          <GridTile key={`${index}:${picture.src}`} picture={picture} />
        ),
      )}
    </div>
  );
}
