import type { ResolvedRomeNewsItem } from "@rome-os/rome-web-components/news-item/schema";
import { HorizontalScrollRail } from "@/components/chat/HorizontalScrollRail";
import { QuickEntryCard } from "@/components/chat/QuickEntryCard";

export interface QuickEntryGridProps {
  entries: ResolvedRomeNewsItem[];
  onActivate: (entry: ResolvedRomeNewsItem) => void;
}

/** Horizontally scrollable rail of quick-entry tiles. Renders nothing when there are none. */
export function QuickEntryGrid({ entries, onActivate }: QuickEntryGridProps) {
  if (entries.length === 0) return null;

  return (
    <HorizontalScrollRail id="rome-news">
      {entries.map((entry) => (
        <div
          className="w-[min(58.5vw,13.5rem)] flex-none sm:w-[13.5rem]"
          role="listitem"
          key={entry.id}
        >
          <QuickEntryCard entry={entry} onActivate={onActivate} />
        </div>
      ))}
    </HorizontalScrollRail>
  );
}
