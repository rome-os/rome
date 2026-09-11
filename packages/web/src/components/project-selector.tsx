import { forwardRef, useMemo, useRef, type Ref } from "react";
import type { TFunction } from "i18next";
import { Check, ChevronDown, FolderPlus, X } from "lucide-react";
import { shouldSubmitOnEnter } from "@/lib/keyboard-submit";
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { IconButton } from "@/components/ui/icon-button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { EmptyState, EmptyStateIcon, EmptyStateTitle } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Spinner } from "@rome-os/ui/spinner";

interface ProjectOption {
  displayName?: string;
  name: string;
  path: string;
  projectPath?: string;
}

interface ProjectCatalog {
  rootPath: string;
  defaultPath: string;
  projects: ProjectOption[];
}

interface ProjectSelectorProps {
  disabled?: boolean;
  t: TFunction;
  projectCatalog: ProjectCatalog | null;
  projectsLoading: boolean;
  projectsError: string | null;
  draftProjectName: string;
  draftProjectLabel: string;
  defaultProjectName: string;
  menuOpen: boolean;
  searchQuery: string;
  setSearchQuery: (value: string) => void;
  createFormOpen: boolean;
  setCreateFormOpen: (value: boolean) => void;
  newProjectName: string;
  setNewProjectName: (value: string) => void;
  creatingProject: boolean;
  connectOnCreate: boolean;
  setConnectOnCreate: (value: boolean) => void;
  onToggleMenu: () => void;
  onPickProject: (name: string) => void;
  onCreateProject: () => void;
}

function getProjectDisplayName(name: string): string {
  const segments = name.split("/").filter(Boolean);
  return segments.at(-1) ?? name;
}

export const ProjectSelector = forwardRef(function ProjectSelector(
  {
    disabled = false,
    t,
    projectCatalog,
    projectsLoading,
    projectsError,
    draftProjectName,
    draftProjectLabel,
    defaultProjectName,
    menuOpen,
    searchQuery,
    setSearchQuery,
    createFormOpen,
    setCreateFormOpen,
    newProjectName,
    setNewProjectName,
    creatingProject,
    connectOnCreate,
    setConnectOnCreate,
    onToggleMenu,
    onPickProject,
    onCreateProject,
  }: ProjectSelectorProps,
  ref: Ref<HTMLDivElement>,
) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isDefault = draftProjectName === defaultProjectName;
  const projects = projectCatalog?.projects ?? [];

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) =>
      [p.name, p.displayName, p.projectPath].some((value) => value?.toLowerCase().includes(q)),
    );
  }, [projects, searchQuery]);

  const namedProjects = filtered.filter((p) => p.name !== defaultProjectName);
  const defaultProject =
    filtered.find((p) => p.name === defaultProjectName) ??
    (searchQuery.trim() ? null : { name: defaultProjectName, path: "" });

  // Rendered above the list rather than inside it: cmdk gives CommandList
  // role="listbox", whose children have to be options or groups. Non-null
  // exactly when there are no project rows to show.
  const status = projectsLoading
    ? { text: t("project.loading"), loading: true }
    : namedProjects.length > 0
      ? null
      : projects.length > 0 && filtered.length === 0
        ? {
            text: t("project.noMatchesQuery", { query: searchQuery }),
            loading: false,
          }
        : {
            text: t("project.noMatches"),
            loading: false,
          };

  const resetRowVisible = Boolean(!projectsLoading && defaultProject);

  return (
    <div ref={ref} className="shrink-0">
      <Popover
        open={menuOpen && !disabled}
        onOpenChange={(next) => {
          if (disabled) return;
          if (next !== menuOpen) onToggleMenu();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            type="button"
            // The fill is the variant's job: transparent while the default
            // project is in play, filled once a real one is, and each variant
            // carries its own open-state fill through `aria-expanded`. `ghost`
            // sets no resting colour, so the label takes one or it reads as the
            // loudest thing in a row of muted chrome.
            variant={isDefault ? "ghost" : "secondary"}
            size="sm"
            disabled={disabled}
            className={cn("max-w-[200px] touch-target", isDefault && "text-muted-foreground")}
            title={isDefault ? t("project.buttonLabel") : draftProjectLabel}
            aria-label={t("project.buttonLabel")}
          >
            <span className="truncate">{isDefault ? defaultProjectName : draftProjectLabel}</span>
            <ChevronDown data-icon="inline-end" aria-hidden="true" />
          </Button>
        </PopoverTrigger>

        <PopoverContent
          side="top"
          align="start"
          sideOffset={8}
          aria-label={t("project.menuTitle")}
          className="w-80 gap-0 overflow-hidden rounded-12 p-0 shadow-10"
        >
          {/* Filtering stays here rather than moving to cmdk: cmdk sorts matches
              by score, which would unpin the trailing "no project selected"
              row from the bottom of the list. */}
          <Command
            shouldFilter={false}
            loop
            // Matches ChatSearchDialog: Ctrl+K opens chat search from anywhere,
            // and cmdk would also read it as "previous result".
            vimBindings={false}
            // cmdk renders this as the hidden label naming the input, and
            // aria-labelledby beats aria-label, so this string is what decides
            // the combobox's accessible name. The popover keeps its own title.
            label={t("project.searchPlaceholder")}
            className="bg-transparent"
          >
            <CommandInput
              ref={searchInputRef}
              autoFocus
              // Same string as the label above, which is what actually names the
              // field; this only matters if cmdk ever stops emitting
              // aria-labelledby. Keeping them equal means they cannot disagree.
              aria-label={t("project.searchPlaceholder")}
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder={t("project.searchPlaceholder")}
            >
              {searchQuery && (
                <IconButton
                  size="sm"
                  label={t("project.clearSearch")}
                  icon={<X aria-hidden />}
                  // The button unmounts as the query empties, so focus has to be
                  // handed back or it falls to <body> and the arrow keys die.
                  onClick={() => {
                    setSearchQuery("");
                    searchInputRef.current?.focus();
                  }}
                  className="text-muted-foreground hover:text-foreground"
                />
              )}
            </CommandInput>

            {/* Outside the listbox, whose children have to be options or
                groups. EmptyState announces the loading or empty state. The
                list itself stays mounted even while empty: cmdk's input always
                points `aria-controls` at it, so unmounting would leave that
                reference dangling. */}
            {status ? (
              <EmptyState>
                {status.loading ? (
                  <EmptyStateIcon>
                    <Spinner label={status.text} />
                  </EmptyStateIcon>
                ) : null}
                <EmptyStateTitle>{status.text}</EmptyStateTitle>
              </EmptyState>
            ) : null}

            {/* The reset row is sticky, so it overlays the bottom of the
                scrollport. cmdk scrolls the highlight into view with
                `block: "nearest"`, which only sees the scrollport bounds and
                would leave a row parked underneath it — selected but invisible.
                The scroll padding rounds the row's 41px up to the nearest step,
                48px: over-reserving only over-scrolls a little, whereas
                under-reserving parks the row out of sight again. That couples
                the constant to the row's height — revisit it if the row grows,
                e.g. if a longer translation of `noProjectSelected` wraps to a
                second line at this popover's width. */}
            <CommandList
              label={t("project.listLabel")}
              className={`max-h-[260px] ${resetRowVisible ? "scroll-pb-12" : ""}`}
            >
              {status ? null : (
                <CommandGroup>
                  {namedProjects.map((project, index) => {
                    const isSelected = project.name === draftProjectName;
                    return (
                      <CommandItem
                        key={project.name}
                        // cmdk keys the roving selection on `value` and folds
                        // case, so two names differing only in case would
                        // register as one option and Enter could pick the wrong
                        // one. Names are user-supplied, so the index keeps them
                        // distinct. Nothing reads the value — filtering is ours.
                        value={`${index}:${project.name}`}
                        onSelect={() => onPickProject(project.name)}
                        className="text-foreground"
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {project.displayName ?? getProjectDisplayName(project.name)}
                        </span>
                        <span className="flex w-3.5 justify-center text-foreground">
                          {isSelected ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              )}

              {/* Withheld until the catalog lands. Mounted during the loading
                  frame this is the only option, so cmdk selects it and keeps
                  that selection once the projects arrive — leaving the
                  highlight on the trailing reset row instead of the first
                  project, which is then what Enter picks. */}
              {!projectsLoading && defaultProject && (
                // Sticky so it stays visible once the projects overflow the
                // list's own scroll box — before the migration it sat in a
                // footer outside that box. Opaque, or the rows scroll under it.
                //
                // This row's height is what the list reserves as scroll padding
                // above; changing its padding or type here means rechecking
                // that value, or a highlighted row parks underneath it again.
                // The failure is visual only, so no test will catch it.
                <CommandGroup className="sticky bottom-0 border-t border-border-subtle bg-popover">
                  <CommandItem
                    value={defaultProject.name}
                    onSelect={() => onPickProject(defaultProject.name)}
                    className="text-muted-foreground"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {defaultProject.name}
                      <span className="ml-2 text-aux text-subtle-foreground">
                        {t("project.noProjectSelected")}
                      </span>
                    </span>
                    <span className="flex w-3.5 justify-center text-foreground">
                      {isDefault ? <Check className="size-3.5 shrink-0" aria-hidden /> : null}
                    </span>
                  </CommandItem>
                </CommandGroup>
              )}
            </CommandList>
          </Command>

          {/* Outside <Command>: cmdk's root claims the arrow keys and Enter that
              the new-project field needs for editing and submit. */}
          <div className="border-t border-border-subtle p-1">
            {createFormOpen ? (
              <div className="px-1 py-1">
                <div className="flex gap-2">
                  <Input
                    autoFocus
                    value={newProjectName}
                    onChange={(event) => setNewProjectName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        setCreateFormOpen(false);
                        setNewProjectName("");
                        return;
                      }
                      if (shouldSubmitOnEnter(event)) {
                        event.preventDefault();
                        onCreateProject();
                      }
                    }}
                    placeholder={t("project.createPlaceholder")}
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    disabled={creatingProject || !newProjectName.trim()}
                    onClick={onCreateProject}
                  >
                    {t("project.createButton")}
                  </Button>
                </div>
                <label className="mt-2 flex cursor-pointer items-center justify-between gap-2 px-1 text-aux text-muted-foreground">
                  <span>{t("project.connectOnCreate", "Connect to a source after creating")}</span>
                  <Switch checked={connectOnCreate} onCheckedChange={setConnectOnCreate} />
                </label>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setCreateFormOpen(true)}
                className="flex w-full items-center gap-2 rounded-8 px-2 py-1 text-left text-ui text-foreground transition hover:bg-surface-muted"
              >
                <span className="flex h-[22px] w-[22px] items-center justify-center text-muted-foreground">
                  <FolderPlus className="size-4 shrink-0" aria-hidden />
                </span>
                {t("project.createAction")}
              </button>
            )}
          </div>

          {projectsError && (
            <div className="border-t border-border-subtle px-3 py-2 text-aux text-destructive-fg">
              {projectsError}
            </div>
          )}
        </PopoverContent>
      </Popover>
    </div>
  );
});
