import { NewsItemCard } from "@rome-os/rome-web-components/news-item";
import type { QuickEntry } from "@/config/quick-entries";
import { RomeLogo } from "@/components/logo";

export interface QuickEntryCardProps {
  entry: QuickEntry;
  onActivate: (entry: QuickEntry) => void;
}

/**
 * A single shortcut tile: a 16:9 cover image above a title and optional
 * subtitle. While the image loads — or if it fails — a gray Rome-logo loading
 * placeholder stands in, so a tile never shows a broken image.
 */
export function QuickEntryCard({ entry, onActivate }: QuickEntryCardProps) {
  return (
    <NewsItemCard
      item={entry}
      onActivate={onActivate}
      placeholder={<RomeLogo className="h-6 w-6" aria-hidden />}
      className="[&_.rome-news-item-subtitle]:!text-ui"
    />
  );
}
