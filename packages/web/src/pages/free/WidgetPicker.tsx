import { Chrome, FolderKanban } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { EmptyState, EmptyStateTitle } from "@/components/ui/empty-state";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApps } from "@/hooks/use-apps";
import type { WidgetPlacement, WidgetType } from "./use-free-cells";

interface WidgetPickerProps {
  onSelect: (type: WidgetType, targetId?: string) => void;
  children: React.ReactNode;
  placements?: WidgetPlacement[];
}

export function WidgetPicker({ onSelect, children, placements = [] }: WidgetPickerProps) {
  const { t } = useTranslation("common");
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { apps: allApps } = useApps();
  const apps = useMemo(
    () => (allApps ?? []).filter((a) => a.hasFrontend && a.status === "active"),
    [allApps],
  );

  // The two widgets Rome ships itself. Each carries its type as a search term
  // alongside its label, so "desktop" finds the Browser row in any locale.
  const builtIns: { type: WidgetType; label: string; icon: React.ReactNode }[] = [
    {
      type: "desktop",
      label: t("chat.addDesktop"),
      icon: <Chrome className="text-subtle-foreground" />,
    },
    {
      type: "projects",
      label: t("chat.addProjects"),
      icon: <FolderKanban className="text-subtle-foreground" />,
    },
  ];

  // Filtering stays here rather than moving to cmdk, whose matcher is fuzzy:
  // it scores "Projects" above "Recipe Box" for the query "rec" and then
  // highlights it, so Enter adds a widget the guardian did not search for.
  const q = query.trim().toLowerCase();
  const matches = (...fields: string[]) =>
    !q || fields.some((field) => field.toLowerCase().includes(q));

  const shownBuiltIns = builtIns.filter((w) => matches(w.label, w.type));
  const shownApps = apps.filter((app) => matches(app.displayName, app.id));
  // Only while unfiltered: under a query the absence of app rows is the
  // query's doing, and the no-results panel below already says so.
  const appsEmptyRow = !q && apps.length === 0;
  const nothingToShow = shownBuiltIns.length === 0 && shownApps.length === 0 && !appsEmptyRow;

  // Selecting closes the surface, so the query has to be dropped with it —
  // otherwise the next open shows the list still filtered by the last search.
  function pick(type: WidgetType, targetId?: string) {
    setOpen(false);
    setQuery("");
    onSelect(type, targetId);
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery("");
      }}
    >
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        align="end"
        aria-label={t("chat.add")}
        className="w-72 gap-0 overflow-hidden p-0"
      >
        <Command
          shouldFilter={false}
          loop
          // Ctrl+K opens chat search from anywhere, and cmdk would also read it
          // as "previous result". Matches ChatSearchDialog and ProjectSelector.
          vimBindings={false}
          // cmdk renders this as the hidden label naming the input, and
          // aria-labelledby beats aria-label, so this decides the combobox's
          // accessible name. The popover keeps its own label.
          label={t("chat.searchWidgets")}
          className="bg-transparent"
        >
          <CommandInput
            autoFocus
            aria-label={t("chat.searchWidgets")}
            value={query}
            onValueChange={setQuery}
            placeholder={t("chat.searchWidgets")}
          />

          {/* Outside the listbox, whose children have to be options or groups.
              The list itself stays mounted even while empty: cmdk's input
              always points `aria-controls` at it, so unmounting would leave
              that reference dangling. */}
          {nothingToShow ? (
            // Shorter than the component's intrinsic height, which is sized for
            // a page panel: the full list here is about five rows, so keeping
            // `min-h-48` would make the no-results panel the tallest state the
            // picker has.
            <EmptyState className="min-h-0 py-6">
              <EmptyStateTitle>
                {t("chat.noWidgetMatches", { query: query.trim() })}
              </EmptyStateTitle>
            </EmptyState>
          ) : null}

          <CommandList className="max-h-[280px]">
            {shownBuiltIns.length > 0 && (
              <CommandGroup>
                {shownBuiltIns.map((widget) => (
                  <CommandItem
                    key={widget.type}
                    data-coach={widget.type === "desktop" ? "widget-browser" : undefined}
                    value={widget.type}
                    onSelect={() => pick(widget.type)}
                  >
                    {widget.icon}
                    {widget.label}
                    {placements.some((p) => p.type === widget.type) && (
                      <span className="ml-auto text-aux text-muted-foreground">
                        {t("chat.toolOpened")}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {shownBuiltIns.length > 0 && (shownApps.length > 0 || appsEmptyRow) && (
              <CommandSeparator />
            )}

            {appsEmptyRow && (
              <CommandGroup>
                {/* A row rather than a line above the list: `CommandList` is the
                    listbox, whose children have to be options or groups.
                    Disabled, so the roving selection skips it. */}
                <CommandItem disabled value="no-apps">
                  {t("chat.noApps")}
                </CommandItem>
              </CommandGroup>
            )}

            {shownApps.length > 0 && (
              <CommandGroup>
                {shownApps.map((app) => (
                  <CommandItem
                    key={app.id}
                    // cmdk keys its roving selection on `value` and folds
                    // case, so two apps sharing a display name would register
                    // as one option. Ids are unique, and the prefix keeps an
                    // app whose id is "desktop" or "projects" off a built-in's
                    // value. Nothing reads it — the filtering above is ours.
                    value={`app:${app.id}`}
                    onSelect={() => pick("app", app.id)}
                  >
                    {app.iconUrl ? (
                      <img src={app.iconUrl} alt="" className="size-4 rounded-4" />
                    ) : (
                      <span className="flex size-4 items-center justify-center rounded-4 bg-surface-muted text-badge text-muted-foreground">
                        {app.displayName.charAt(0).toUpperCase()}
                      </span>
                    )}
                    <span className="truncate">{app.displayName}</span>
                    {placements.some((p) => p.type === "app" && p.targetId === app.id) && (
                      <span className="ml-auto text-aux text-muted-foreground">
                        {t("chat.toolOpened")}
                      </span>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
