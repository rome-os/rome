import { usePreviewScale } from "@/hooks/use-preview-scale";
import { useEffect, useState } from "react";
import { ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_THEME_NAME, type ThemePreference } from "@/lib/theme";
import { FoundationsSection } from "./sections/foundations";
import { ControlsSection } from "./sections/controls";
import { NavigationSection } from "./sections/navigation";
import { DisplaySection } from "./sections/display";
import { OverlaysSection } from "./sections/overlays";

const SECTION_LABELS: Record<string, string> = {
  foundations: "Foundations",
  controls: "Controls",
  navigation: "Navigation",
  display: "Display",
  overlays: "Overlays",
};

type NavSection = { id: string; label: string; components: { id: string; name: string }[] };

/**
 * Build the index by walking what actually rendered, rather than keeping a
 * hand-written list beside the sections. Adding a `<Component>` puts it in the
 * sidebar automatically, so the index can never claim a component the page
 * doesn't show — or omit one it does.
 */
function readNavFromDom(): NavSection[] {
  return [...document.querySelectorAll("main section[id]")].map((section) => ({
    id: section.id,
    label: SECTION_LABELS[section.id] ?? section.id,
    components: [...section.querySelectorAll("[data-gallery-component]")].map((node) => ({
      id: node.id,
      name: node.getAttribute("data-gallery-component") ?? node.id,
    })),
  }));
}

const MODES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

function jumpToGalleryItem(id: string) {
  const target = document.getElementById(id);
  if (!target) return;

  const header = document.querySelector<HTMLElement>("[data-gallery-header]");
  const headerOffset = (header?.offsetHeight ?? 0) + 16;
  const top = target.getBoundingClientRect().top + window.scrollY - headerOffset;

  window.history.replaceState(window.history.state, "", `#${id}`);
  window.scrollTo({ top, behavior: "smooth" });
}

function gallerySearchValue(section: string, name: string, id: string) {
  const searchableName = name.replace(/([a-z\d])([A-Z])/g, "$1 $2");
  return `${section} ${name} ${searchableName} ${id.replaceAll("-", " ")}`;
}

/**
 * Specimen page for the primitives the dashboard renders — those authored in
 * `src/components/ui` and those it imports from the `@rome-os/ui` kit. Both
 * kinds sit on the same page deliberately: a kit component that drifts from
 * the dashboard's idiom shows up next to the piece it is meant to replace.
 *
 * Switches theme through the dashboard's own `ThemeProvider` rather than
 * toggling a class by hand, so every theme × mode combination here is the one
 * the dashboard renders — and a specimen that reads theme from context, as
 * `Markdown` does for its Mermaid palette, sees exactly what it would in the
 * app. That is the point of the page: a token defined in only one half of a
 * theme shows up as a broken specimen immediately. The switchers write the
 * same stored preference the dashboard reads, so a theme picked here is the
 * theme the rest of the app renders in.
 */
export default function ComponentGalleryPage() {
  const {
    preference,
    setPreference,
    theme: themeName,
    setTheme: setThemeName,
    themes,
  } = useTheme();
  const { scale, setScale } = usePreviewScale();
  const [nav, setNav] = useState<NavSection[]>([]);
  const [navOpen, setNavOpen] = useState(false);

  // After the first paint, so the sections it indexes are in the DOM.
  useEffect(() => {
    setNav(readNavFromDom());
  }, []);

  const themeOptions = themes.map((entry) => ({ value: entry.id, label: entry.label }));

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header
        data-gallery-header
        className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur"
      >
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div>
            <h1 className="font-serif text-title text-foreground">Rome components</h1>
            <p className="text-aux text-muted-foreground">
              Live specimens from src/components/ui and @rome-os/ui — dev only, dropped from
              production builds.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {themeOptions.length > 1 ? (
              <SegmentedControl
                aria-label="Theme"
                size="sm"
                options={themeOptions}
                value={themeName || DEFAULT_THEME_NAME}
                onValueChange={setThemeName}
              />
            ) : null}
            <SegmentedControl
              aria-label="Color mode"
              size="sm"
              options={MODES}
              value={preference}
              onValueChange={(value) => setPreference(value as ThemePreference)}
            />
            <div className="flex items-center gap-2">
              <span className="text-aux text-muted-foreground">Control scale</span>
              <SegmentedControl
                aria-label="Preview scale"
                size="sm"
                value={scale}
                onValueChange={setScale}
                options={[
                  { value: "auto", label: "Auto" },
                  { value: "medium", label: "Medium" },
                  { value: "large", label: "Large" },
                ]}
              />
            </div>
            <nav aria-label="Component table of contents" className="lg:hidden">
              <Popover open={navOpen} onOpenChange={setNavOpen}>
                <PopoverTrigger asChild>
                  <Button
                    align="between"
                    aria-expanded={navOpen}
                    className="w-48"
                    role="combobox"
                    size="sm"
                    variant="outline"
                  >
                    Jump to component
                    <ChevronsUpDown aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-72 p-0">
                  <Command>
                    <CommandInput placeholder="Search components…" />
                    <CommandList>
                      <CommandEmpty>No components found.</CommandEmpty>
                      {nav.map((section) => (
                        <CommandGroup key={section.id} heading={section.label}>
                          <CommandItem
                            value={`${section.label} overview`}
                            onSelect={() => {
                              jumpToGalleryItem(section.id);
                              setNavOpen(false);
                            }}
                          >
                            {section.label} overview
                          </CommandItem>
                          {section.components.map((component) => (
                            <CommandItem
                              key={component.id}
                              value={gallerySearchValue(
                                section.label,
                                component.name,
                                component.id,
                              )}
                              onSelect={() => {
                                jumpToGalleryItem(component.id);
                                setNavOpen(false);
                              }}
                            >
                              {component.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      ))}
                    </CommandList>
                  </Command>
                </PopoverContent>
              </Popover>
            </nav>
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl gap-8 px-6 py-8">
        <nav
          aria-label="Components"
          className="sticky top-24 hidden h-[calc(100dvh-8rem)] w-48 shrink-0 overflow-y-auto lg:block"
        >
          <ul className="space-y-4">
            {nav.map((section) => (
              <li key={section.id}>
                <a
                  href={`#${section.id}`}
                  className="block px-2 text-ui text-foreground hover:underline"
                >
                  {section.label}
                </a>
                {section.components.length > 0 ? (
                  <ul className="mt-1 space-y-1">
                    {section.components.map((component) => (
                      <li key={component.id}>
                        <a
                          href={`#${component.id}`}
                          className="block rounded-8 px-2 py-1 text-ui text-muted-foreground hover:bg-surface-hover hover:text-foreground"
                        >
                          {component.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ul>
        </nav>

        <main className="min-w-0 flex-1 space-y-12">
          <FoundationsSection />
          <ControlsSection />
          <NavigationSection />
          <DisplaySection />
          <OverlaysSection />
        </main>
      </div>
    </div>
  );
}
