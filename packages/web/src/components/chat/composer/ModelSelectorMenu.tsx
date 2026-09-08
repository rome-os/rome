import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, ChevronUp, ListPlus, X } from "lucide-react";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { cn } from "@/lib/utils";
import {
  COMMON_LARGE_MODEL_IDS,
  DEFAULT_LARGE_MODEL_SELECTION,
  LARGE_MODEL_FAMILY_LABEL_KEYS,
  LARGE_MODEL_FAMILY_ORDER,
  LARGE_MODEL_OPTIONS,
  type LargeModelOption,
} from "@/lib/chat-constants";

export interface ModelSelectorMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}

// The picker is a combobox rather than a flat menu (issue #180): the list grows
// with every model release, yet almost every open ends on the same two or three
// rows. So it opens on a short curated list, folds the rest behind "show all",
// and filters every model as the guardian types.
export function ModelSelectorMenu({
  open,
  onOpenChange,
  value,
  onChange,
  disabled,
}: ModelSelectorMenuProps) {
  const { t } = useTranslation("chat");
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  // `auto` is a value like any other, so the trigger always has something to
  // name. The label IS the state — nothing has to encode "non-default" on top.
  const selected =
    LARGE_MODEL_OPTIONS.find((option) => option.id === value) ??
    LARGE_MODEL_OPTIONS.find((option) => option.id === DEFAULT_LARGE_MODEL_SELECTION)!;

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0;

  const matches = (option: LargeModelOption) =>
    !searching ||
    t(option.labelKey).toLowerCase().includes(trimmed) ||
    option.id.toLowerCase().includes(trimmed);

  const autoOption = LARGE_MODEL_OPTIONS.find((option) => !option.family);
  const familyOptions = LARGE_MODEL_OPTIONS.filter((option) => option.family);

  // The collapsed short list is the curated common set plus the current
  // selection, so a deliberately-pinned uncommon model still shows its check.
  const shortListIds = new Set<string>([...COMMON_LARGE_MODEL_IDS, value]);
  const shortFamilyOptions = familyOptions.filter((option) => shortListIds.has(option.id));

  // Expanded and searching both render the full set grouped by family; only the
  // former keeps every row, the latter keeps the matches.
  const grouped = LARGE_MODEL_FAMILY_ORDER.map((family) => ({
    family,
    options: familyOptions.filter((option) => option.family === family && matches(option)),
  })).filter((group) => group.options.length > 0);

  const autoVisible = autoOption ? matches(autoOption) : false;
  const resultCount =
    (autoVisible ? 1 : 0) + grouped.reduce((total, group) => total + group.options.length, 0);

  // Reset the transient view each time the menu closes so the next open starts
  // on the short list with an empty query.
  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setQuery("");
      setShowAll(false);
    }
    onOpenChange(next);
  };

  const pick = (id: string) => {
    onChange(id);
    handleOpenChange(false);
  };

  const renderRow = (option: LargeModelOption) => {
    const isSelected = option.id === value;
    return (
      <CommandItem
        key={option.id}
        value={option.id}
        onSelect={() => pick(option.id)}
        className={cn(isSelected ? "text-info-fg" : "text-foreground")}
      >
        <span className="min-w-0 flex-1 truncate">{t(option.labelKey)}</span>
        <span className="flex w-3.5 justify-center">
          {isSelected ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
        </span>
      </CommandItem>
    );
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label={t("modelSelector.label")}
          title={t("modelSelector.label")}
          className="touch-target"
        >
          <span>{t(selected.labelKey)}</span>
          <ChevronDown data-icon="inline-end" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        aria-label={t("modelSelector.label")}
        className="w-64 gap-0 overflow-hidden rounded-12 p-0 shadow-10"
      >
        {/* Filtering stays ours (shouldFilter={false}): it keeps `auto` pinned
            above the families and preserves the curated generation order, which
            cmdk's score-based sort would scramble. */}
        <Command
          shouldFilter={false}
          loop
          // Matches ChatSearchDialog: Ctrl+K opens chat search from anywhere,
          // and cmdk would also read it as "previous result".
          vimBindings={false}
          // cmdk renders this as the hidden label naming the combobox input.
          label={t("modelSelector.searchPlaceholder")}
          className="bg-transparent"
        >
          <CommandInput
            ref={searchInputRef}
            autoFocus
            aria-label={t("modelSelector.searchPlaceholder")}
            value={query}
            onValueChange={setQuery}
            placeholder={t("modelSelector.searchPlaceholder")}
          >
            {query && (
              <IconButton
                size="sm"
                label={t("modelSelector.clearSearch")}
                icon={<X aria-hidden />}
                // The button unmounts as the query empties, so focus has to be
                // handed back or it falls to <body> and the arrow keys die.
                onClick={() => {
                  setQuery("");
                  searchInputRef.current?.focus();
                }}
                className="text-muted-foreground hover:text-foreground"
              />
            )}
          </CommandInput>

          {/* Outside the listbox, whose children have to be options or groups. */}
          {searching && resultCount === 0 ? (
            <p className="py-6 text-center text-ui text-muted-foreground">
              {t("modelSelector.noMatches", { query: query.trim() })}
            </p>
          ) : null}

          {/* Kept mounted even while empty: cmdk's input always points
              aria-controls at it, so unmounting leaves that reference dangling. */}
          <CommandList label={t("modelSelector.label")}>
            {autoVisible && autoOption ? (
              <CommandGroup>{renderRow(autoOption)}</CommandGroup>
            ) : null}

            {searching || showAll ? (
              grouped.map((group) => (
                <CommandGroup
                  key={group.family}
                  heading={t(LARGE_MODEL_FAMILY_LABEL_KEYS[group.family])}
                >
                  {group.options.map(renderRow)}
                </CommandGroup>
              ))
            ) : (
              <CommandGroup>{shortFamilyOptions.map(renderRow)}</CommandGroup>
            )}
          </CommandList>
        </Command>

        {/* The "ellipsis" affordance, outside <Command> so cmdk's root does not
            claim the Enter/arrow keys the toggle would otherwise use. Hidden
            while searching, since search already spans every model. */}
        {!searching ? (
          <div className="border-t border-border-subtle p-1">
            <button
              type="button"
              onClick={() => setShowAll((previous) => !previous)}
              aria-expanded={showAll}
              className="flex w-full items-center gap-2 rounded-8 px-2 py-1 text-left text-ui text-muted-foreground transition hover:bg-surface-muted hover:text-foreground"
            >
              <span className="flex h-[22px] w-[22px] items-center justify-center">
                {showAll ? (
                  <ChevronUp className="size-4 shrink-0" aria-hidden />
                ) : (
                  <ListPlus className="size-4 shrink-0" aria-hidden />
                )}
              </span>
              {showAll ? t("modelSelector.showLess") : t("modelSelector.showAll")}
            </button>
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
