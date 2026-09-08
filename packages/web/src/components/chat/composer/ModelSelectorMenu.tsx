import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, ChevronDown, MoreHorizontal, X } from "lucide-react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { IconButton } from "@/components/ui/icon-button";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  COMMON_LARGE_MODEL_IDS,
  DEFAULT_LARGE_MODEL_SELECTION,
  LARGE_MODEL_OPTIONS,
} from "@/lib/chat-constants";

// A value no model id can collide with, so the "show all" row and the model
// rows never share a cmdk key.
const SHOW_ALL_VALUE = "__show_all__";

export interface ModelSelectorMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: string;
  onChange: (next: string) => void;
  disabled: boolean;
}

/**
 * The chat model picker. The menu opened flat — one row per model, no grouping,
 * no search — and grew with every release, yet almost every open lands on the
 * same two or three rows (#180). So it is a combo box: a small curated set of
 * common models shows first, the rest fold behind a "show all" row, and typing
 * filters across the whole catalog. The currently selected model is always
 * shown even when it is not in the curated set, so a deliberately pinned older
 * model is never hidden.
 */
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

  // Resolve labels once so the trigger, the filter, and the rows all read the
  // exact same text — a single source for "what the model is called".
  const options = useMemo(
    () => LARGE_MODEL_OPTIONS.map((option) => ({ ...option, label: t(option.labelKey) })),
    [t],
  );

  // `auto` is a value like any other, so the trigger always has something to
  // name. The label IS the state — nothing has to encode "non-default" on top.
  // Resolved from `options` (not raw LARGE_MODEL_OPTIONS) so the trigger renders
  // the same translated label as the rows, with no second lookup path.
  const selected =
    options.find((option) => option.id === value) ??
    options.find((option) => option.id === DEFAULT_LARGE_MODEL_SELECTION)!;

  const trimmedQuery = query.trim().toLowerCase();

  // Three view states share one list:
  //  - typing filters across every model — search already spans the catalog, so
  //    the "show all" row would be redundant and is withheld;
  //  - collapsed shows the curated common set plus whatever is selected (so a
  //    deliberately pinned model stays visible), with a trailing "show all" row;
  //  - expanded shows the full catalog in its declared order.
  const { rows, showAllRow } = useMemo(() => {
    if (trimmedQuery) {
      return {
        rows: options.filter(
          (option) =>
            option.label.toLowerCase().includes(trimmedQuery) ||
            option.id.toLowerCase().includes(trimmedQuery),
        ),
        showAllRow: false,
      };
    }
    if (showAll) {
      return { rows: options, showAllRow: false };
    }
    const common = options.filter(
      (option) => COMMON_LARGE_MODEL_IDS.includes(option.id) || option.id === value,
    );
    return { rows: common, showAllRow: common.length < options.length };
  }, [options, trimmedQuery, showAll, value]);

  function resetView() {
    setQuery("");
    setShowAll(false);
  }

  // Picking a row closes the menu by flipping the parent's `open` prop, which
  // Radix does NOT route through the Popover's onOpenChange wrapper below — so
  // resetting only there would leave `query`/`showAll` alive across a select and
  // reopen filtered or expanded. Route every close through here instead, so the
  // documented "each open starts collapsed and unfiltered" contract holds on the
  // most common path too.
  function close() {
    resetView();
    onOpenChange(false);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        // Each open starts collapsed and unfiltered — the whole point is that
        // the common rows are the first thing seen.
        if (!next) resetView();
        onOpenChange(next);
      }}
    >
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
          <span>{selected.label}</span>
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
        {/* Filtering stays ours (shouldFilter=false): cmdk sorts matches by
            score, which would reorder the curated rows and unpin the trailing
            "show all" row from the bottom of the list. */}
        <Command
          shouldFilter={false}
          loop
          // Ctrl+K opens chat search app-wide; cmdk would also read it as
          // "previous result". Matches ChatSearchDialog / ProjectSelector.
          vimBindings={false}
          // cmdk renders this as the hidden label naming the combobox, and
          // aria-labelledby beats aria-label, so this decides the accessible
          // name. The popover keeps its own aria-label.
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
          <CommandList label={t("modelSelector.label")} className="max-h-72">
            <CommandEmpty>{t("modelSelector.noMatches")}</CommandEmpty>
            <CommandGroup>
              {rows.map((option) => (
                <CommandItem
                  key={option.id}
                  value={option.id}
                  onSelect={() => {
                    onChange(option.id);
                    close();
                  }}
                  className={cn(
                    "justify-between",
                    value === option.id ? "text-info-fg" : "text-foreground",
                  )}
                >
                  <span className="min-w-0 flex-1 truncate">{option.label}</span>
                  <span className="flex w-3.5 justify-center">
                    {value === option.id ? (
                      <Check className="size-3.5 shrink-0" aria-hidden="true" />
                    ) : null}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
            {showAllRow && (
              <CommandGroup className="border-t border-border-subtle">
                <CommandItem
                  value={SHOW_ALL_VALUE}
                  onSelect={() => {
                    setShowAll(true);
                    // Keep the menu open and focus in the field so the freshly
                    // revealed rows are reachable by keyboard straight away.
                    searchInputRef.current?.focus();
                  }}
                  className="text-muted-foreground"
                >
                  <MoreHorizontal className="size-3.5 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">
                    {t("modelSelector.showAll", { count: options.length })}
                  </span>
                </CommandItem>
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
