import { forwardRef, useEffect, useMemo, useRef, useState, type Ref } from "react";
import type { TFunction } from "i18next";
import {
  ArrowUp,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  Folder,
  FolderPlus,
  Laptop,
  X,
} from "lucide-react";
import { getProjectDisplayName } from "@/lib/chat-helpers";
import type { ProjectCatalog } from "@/lib/chat-types";
import {
  childPath,
  deviceFolderLabel,
  tildePath,
  type DraftDeviceFolder,
} from "@/lib/device-folder";
import type { DeviceFilesErrorCode } from "@rome/api-types/devices";
import { useDeviceFolderBrowser, type PickerDevice } from "./use-device-folder-browser";
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
  /** The draft's device folder. It excludes a project: the draft holds one or the other. */
  deviceFolder?: DraftDeviceFolder | null;
  /**
   * Enables device folders. With at least one device the menu has two levels:
   * Rome Cloud and each device first, then projects or that device's folders.
   */
  onPickDeviceFolder?: (folder: DraftDeviceFolder) => void;
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
    deviceFolder = null,
    onPickDeviceFolder,
  }: ProjectSelectorProps,
  ref: Ref<HTMLDivElement>,
) {
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const isDefault = draftProjectName === defaultProjectName;
  const projects = projectCatalog?.projects ?? [];
  const browser = useDeviceFolderBrowser(Boolean(onPickDeviceFolder), menuOpen && !disabled);
  const browse = browser.browse;
  const [view, setView] = useState<"root" | "rome">("root");
  useEffect(() => {
    if (!menuOpen) setView("root");
  }, [menuOpen]);
  // With no device the menu stays one level: Rome's projects only.
  const twoLevel = Boolean(onPickDeviceFolder) && browser.devices.length > 0;
  const atRoot = twoLevel && !browse && view === "root";
  const inProjects = !browse && !atRoot;
  const romeLabel = t("project.locations.rome");
  const searchLabel = browse
    ? t("project.devices.searchPlaceholder")
    : atRoot
      ? t("project.locations.searchPlaceholder")
      : t("project.searchPlaceholder");
  const folderLabel = deviceFolder ? deviceFolderLabel(deviceFolder) : null;
  const query = searchQuery.trim().toLowerCase();
  const folderEntries = (browse?.folder?.entries ?? []).filter(
    (entry) =>
      (entry.type === "dir" || entry.type === "symlink") &&
      (!query || entry.name.toLowerCase().includes(query)),
  );
  const browseHome = browse ? browser.homeOf(browse.device.id) : null;
  const browseStatus = !browse
    ? null
    : browse.loading
      ? { text: t("project.devices.loading"), loading: true }
      : browse.error
        ? { text: t(`project.devices.errors.${browse.error}`), loading: false }
        : folderEntries.length === 0
          ? {
              text: query
                ? t("project.devices.noMatchesQuery", { query: searchQuery })
                : t("project.devices.empty"),
              loading: false,
            }
          : null;
  const toRoot = () => {
    browser.close();
    setView("root");
    setSearchQuery("");
  };

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
            variant={isDefault && !folderLabel ? "ghost" : "secondary"}
            size="sm"
            disabled={disabled}
            className={cn(
              "max-w-[200px] touch-target",
              isDefault && !folderLabel && "text-muted-foreground",
            )}
            title={folderLabel ?? (isDefault ? t("project.buttonLabel") : draftProjectLabel)}
            aria-label={t("project.buttonLabel")}
          >
            {folderLabel ? <Laptop data-icon="inline-start" aria-hidden="true" /> : null}
            <span className="truncate">
              {folderLabel ?? (isDefault ? defaultProjectName : draftProjectLabel)}
            </span>
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
          {twoLevel && !atRoot ? (
            <div className="flex items-center gap-1 border-b border-border-subtle p-1">
              <IconButton
                size="sm"
                label={t("project.locations.back")}
                icon={<ChevronLeft aria-hidden />}
                onClick={toRoot}
                className="text-muted-foreground hover:text-foreground"
              />
              <span className="min-w-0 truncate text-ui text-foreground">
                {browse ? browse.device.name : romeLabel}
              </span>
            </div>
          ) : null}

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
            label={searchLabel}
            className="bg-transparent"
          >
            <CommandInput
              ref={searchInputRef}
              autoFocus
              // Same string as the label above, which is what actually names the
              // field; this only matters if cmdk ever stops emitting
              // aria-labelledby. Keeping them equal means they cannot disagree.
              aria-label={searchLabel}
              value={searchQuery}
              onValueChange={setSearchQuery}
              placeholder={searchLabel}
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
            {browse ? (
              <DeviceFolderList
                t={t}
                path={browse.folder?.path ?? null}
                parent={browse.folder?.parent ?? null}
                label={browse.folder ? tildePath(browse.folder.path, browseHome) : ""}
                status={browseStatus}
                entries={browseStatus ? [] : folderEntries}
                truncated={Boolean(browse.folder?.truncated) && !browse.loading}
                onUp={() => {
                  if (browse.folder?.parent) {
                    setSearchQuery("");
                    void browser.open(browse.device, browse.folder.parent);
                  }
                }}
                onOpen={(name) => {
                  if (!browse.folder) return;
                  setSearchQuery("");
                  void browser.open(browse.device, childPath(browse.folder.path, name));
                }}
              />
            ) : null}

            {atRoot ? (
              <LocationList
                t={t}
                query={query}
                romeLabel={romeLabel}
                romeSelection={
                  deviceFolder ? null : isDefault ? defaultProjectName : draftProjectLabel
                }
                devices={browser.devices}
                deviceErrorById={browser.deviceErrorById}
                deviceFolder={deviceFolder}
                onRome={() => {
                  setView("rome");
                  setSearchQuery("");
                }}
                onDevice={(device) => {
                  setSearchQuery("");
                  void browser.open(device);
                }}
              />
            ) : null}

            {!inProjects ? null : status ? (
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
            {!inProjects ? null : (
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
                            {isSelected ? (
                              <Check className="size-3.5 shrink-0" aria-hidden />
                            ) : null}
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
                        {isDefault && !deviceFolder ? (
                          <Check className="size-3.5 shrink-0" aria-hidden />
                        ) : null}
                      </span>
                    </CommandItem>
                  </CommandGroup>
                )}
              </CommandList>
            )}
          </Command>

          {/* Outside <Command>: cmdk's root claims the arrow keys and Enter that
              the new-project field needs for editing and submit. */}
          {atRoot ? null : (
            <div className="border-t border-border-subtle p-1">
              {browse ? (
                <div className="flex px-1 py-1">
                  <Button
                    type="button"
                    className="min-w-0 flex-1"
                    // Not disabled while a folder loads: the button would flicker on every step.
                    // A click then takes the folder the label still shows.
                    disabled={!browse.folder || Boolean(browse.error)}
                    onClick={() => {
                      if (!browse.folder || !onPickDeviceFolder) return;
                      onPickDeviceFolder({
                        deviceId: browse.device.id,
                        deviceName: browse.device.name,
                        path: browse.folder.path,
                        home: browseHome,
                      });
                      toRoot();
                    }}
                  >
                    {t("project.devices.useFolder")}
                  </Button>
                </div>
              ) : createFormOpen ? (
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
                    <span>
                      {t("project.connectOnCreate", "Connect to a source after creating")}
                    </span>
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
          )}

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

interface DeviceFolderListProps {
  t: TFunction;
  path: string | null;
  parent: string | null;
  label: string;
  status: { text: string; loading: boolean } | null;
  entries: { name: string }[];
  truncated: boolean;
  onUp: () => void;
  onOpen: (name: string) => void;
}

/** Browse mode of the selector: one folder of a device, its parent on the top row. */
function DeviceFolderList({
  t,
  path,
  parent,
  label,
  status,
  entries,
  truncated,
  onUp,
  onOpen,
}: DeviceFolderListProps) {
  return (
    <>
      <CommandList label={t("project.devices.listLabel")} className="max-h-[260px]">
        <CommandGroup>
          <CommandItem
            value="device-folder:up"
            disabled={!parent}
            onSelect={onUp}
            className="text-muted-foreground"
          >
            <ArrowUp className="size-4 shrink-0" aria-hidden />
            <span className="min-w-0 flex-1 truncate" title={path ?? undefined}>
              {label}
            </span>
            {parent ? <span className="sr-only">{t("project.devices.up")}</span> : null}
          </CommandItem>
          {entries.map((entry, index) => (
            <CommandItem
              key={entry.name}
              // File names can differ only in case; see the project rows above.
              value={`${index}:${entry.name}`}
              onSelect={() => onOpen(entry.name)}
              className="text-foreground"
            >
              <Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
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
      {truncated ? (
        <p className="px-3 pb-2 text-aux text-subtle-foreground">
          {t("project.devices.truncated")}
        </p>
      ) : null}
    </>
  );
}

interface LocationListProps {
  t: TFunction;
  query: string;
  romeLabel: string;
  /** The project picked in Rome, or null while a device folder is picked. */
  romeSelection: string | null;
  devices: PickerDevice[];
  deviceErrorById: Record<string, DeviceFilesErrorCode>;
  deviceFolder: DraftDeviceFolder | null;
  onRome: () => void;
  onDevice: (device: PickerDevice) => void;
}

/** First level of the two-level menu: where the chat works, Rome Cloud or a device. */
function LocationList({
  t,
  query,
  romeLabel,
  romeSelection,
  devices,
  deviceErrorById,
  deviceFolder,
  onRome,
  onDevice,
}: LocationListProps) {
  const matches = (name: string) => !query || name.toLowerCase().includes(query);
  const visibleDevices = devices.filter((device) => matches(device.name));
  const romeVisible = matches(romeLabel);
  return (
    <>
      {romeVisible || visibleDevices.length > 0 ? null : (
        <EmptyState>
          <EmptyStateTitle>{t("project.locations.noMatchesQuery", { query })}</EmptyStateTitle>
        </EmptyState>
      )}
      <CommandList label={t("project.locations.listLabel")} className="max-h-[260px]">
        <CommandGroup>
          {romeVisible ? (
            <CommandItem value="location:rome" onSelect={onRome} className="text-foreground">
              <Cloud className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 flex-1 truncate">
                {romeLabel}
                {romeSelection ? (
                  <span className="ml-2 text-aux text-subtle-foreground">{romeSelection}</span>
                ) : null}
              </span>
              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            </CommandItem>
          ) : null}
          {visibleDevices.map((device) => {
            const reason = device.status === "connected" ? deviceErrorById[device.id] : "offline";
            const selected = deviceFolder?.deviceId === device.id;
            return (
              <CommandItem
                key={device.id}
                value={`device:${device.id}`}
                disabled={Boolean(reason)}
                onSelect={() => onDevice(device)}
                className="text-foreground"
              >
                <Laptop className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate">
                  {device.name}
                  {selected && deviceFolder ? (
                    <span className="ml-2 text-aux text-subtle-foreground">
                      {tildePath(deviceFolder.path, deviceFolder.home)}
                    </span>
                  ) : null}
                </span>
                {reason ? (
                  <span className="shrink-0 text-aux text-subtle-foreground">
                    {t(`project.devices.reasons.${reason}`)}
                  </span>
                ) : (
                  <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                )}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </>
  );
}
