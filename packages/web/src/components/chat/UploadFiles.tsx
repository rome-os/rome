import { ChatImage } from "@/components/chat/ChatImage";
import { FileChip } from "@/components/chat/FileChip";
import type { UploadLink } from "@/lib/asset-links";

/**
 * The files of a message the guardian sent: pictures as zoomable thumbnails,
 * every other file as a chip.
 */
export function UploadFiles({ uploads }: { uploads: UploadLink[] }) {
  return (
    <div className="flex flex-wrap items-start gap-2">
      {uploads.map((upload) =>
        upload.kind === "image" ? (
          <ChatImage
            key={upload.url}
            src={upload.url}
            alt={upload.label}
            wrapperClassName="my-0"
            className="max-h-40 max-w-48"
          />
        ) : (
          <FileChip key={upload.url} href={upload.url} label={upload.label} />
        ),
      )}
    </div>
  );
}
