import { type ReactNode, useState } from "react";
import { Bell, Languages, Plus } from "lucide-react";
import {
  FormRow,
  FormRowControl,
  FormRowDescription,
  FormRowHeading,
  FormRowIcon,
  FormRowLabel,
  FormRows,
} from "@rome-os/ui/layout-form";
import { ListCollection, ListFooter, ListToolbar } from "@rome-os/ui/layout-list";
import {
  Measure,
  Page,
  PageActions,
  PageDescription,
  PageHeader,
  PageHeading,
  PageTitle,
} from "@rome-os/ui/page";
import { ToolbarButton } from "@rome-os/ui/toolbar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_THEME_NAME, type ThemePreference } from "@/lib/theme";

// Specimen page for the page layouts in `@rome-os/ui`. The catalogue and the
// slot tables are in docs/ui/layouts.md, which takes one layout at a time — so
// does this page.
//
// Layouts are full-page, so they cannot sit in the component gallery's sections
// beside a button and a badge. One layout renders at a time, at the width the
// dashboard would give it, with the gallery's theme and mode switches so a
// layout that reads a token only one theme declares shows up here.

const MODES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

const APPS = [
  { name: "Inbox", owner: "Rome", status: "Running", runs: "1,204" },
  { name: "Feature video", owner: "Rome", status: "Running", runs: "318" },
  { name: "Connector", owner: "Rome", status: "Paused", runs: "96" },
  { name: "Manager", owner: "Mira Osei", status: "Running", runs: "42" },
  { name: "Sessions", owner: "Rome", status: "Failing", runs: "7" },
];

function ListSpecimen() {
  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Apps</PageTitle>
          <PageDescription>Everything installed on this Rome.</PageDescription>
        </PageHeading>
        <PageActions>
          <Button size="sm" variant="outline">
            Import
          </Button>
          <Button size="sm">
            <Plus aria-hidden />
            Install app
          </Button>
        </PageActions>
      </PageHeader>
      <ListToolbar aria-label="Filter apps">
        <Input aria-label="Search apps" placeholder="Search apps…" size="sm" className="w-64" />
        <ToolbarButton asChild>
          <Button size="sm" variant="outline">
            Running
          </Button>
        </ToolbarButton>
        <ToolbarButton asChild>
          <Button size="sm" variant="ghost">
            Paused
          </Button>
        </ToolbarButton>
        <ToolbarButton asChild>
          <Button size="sm" variant="ghost">
            Failing
          </Button>
        </ToolbarButton>
        <ToolbarButton asChild>
          <Button size="sm" variant="ghost">
            Mine
          </Button>
        </ToolbarButton>
      </ListToolbar>
      <ListCollection>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>App</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Runs</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {APPS.map((app) => (
              <TableRow key={app.name}>
                <TableCell>{app.name}</TableCell>
                <TableCell>{app.owner}</TableCell>
                <TableCell>
                  <Badge variant={app.status === "Failing" ? "destructive" : "muted"}>
                    {app.status}
                  </Badge>
                </TableCell>
                <TableCell>{app.runs}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </ListCollection>
      <ListFooter>
        <span className="text-aux text-muted-foreground">5 of 18 apps</span>
        <Button size="sm" variant="outline">
          Show more
        </Button>
      </ListFooter>
    </Page>
  );
}

function FormSpecimen() {
  const [sounds, setSounds] = useState(true);

  return (
    <Page>
      <PageHeader>
        <PageHeading>
          <PageTitle>Settings</PageTitle>
          <PageDescription>Applies to every device you sign in on.</PageDescription>
        </PageHeading>
      </PageHeader>
      <FormRows>
        <FormRow>
          <FormRowIcon>
            <Languages />
          </FormRowIcon>
          <FormRowHeading>
            <FormRowLabel htmlFor="specimen-language">Language</FormRowLabel>
          </FormRowHeading>
          <FormRowControl>
            <Select defaultValue="en">
              <SelectTrigger id="specimen-language">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="zh">中文</SelectItem>
              </SelectContent>
            </Select>
          </FormRowControl>
        </FormRow>
        <FormRow>
          <FormRowIcon>
            <Bell />
          </FormRowIcon>
          <FormRowHeading>
            <FormRowLabel htmlFor="specimen-sounds">Sounds</FormRowLabel>
            <FormRowDescription>Plays when a routine finishes.</FormRowDescription>
          </FormRowHeading>
          <FormRowControl>
            <Switch id="specimen-sounds" checked={sounds} onCheckedChange={setSounds} />
          </FormRowControl>
        </FormRow>
        <FormRow>
          <FormRowHeading>
            <FormRowLabel>Sign out everywhere</FormRowLabel>
            <FormRowDescription>Ends every session but this one.</FormRowDescription>
          </FormRowHeading>
          <FormRowControl>
            <Button size="sm" variant="ghost">
              Sign out
            </Button>
          </FormRowControl>
        </FormRow>
      </FormRows>
    </Page>
  );
}

type Specimen = {
  id: string;
  label: string;
  usage: string;
  /** What to try with the keyboard or the pointer on this specimen. */
  hint?: string;
  render: () => ReactNode;
};

const SPECIMENS: Specimen[] = [
  {
    id: "list",
    label: "List",
    usage:
      "Used for a collection the reader scans or searches to find one item and then leaves. Not used when the reader processes items one by one while keeping the list in view.",
    hint: "Tab to the toolbar, then move between its controls with the arrow keys.",
    render: () => <ListSpecimen />,
  },
  {
    id: "form",
    label: "Form",
    usage:
      "Used for changing settings and seeing the change took: one column at the reading measure, with save state shown where the change was made. Not used for a one-shot linear flow.",
    hint: "Narrow the window: the rows keep their line, and the label wraps rather than pushing its control down.",
    render: () => <FormSpecimen />,
  },
];

export default function LayoutsPage() {
  const {
    preference,
    setPreference,
    theme: themeName,
    setTheme: setThemeName,
    themes,
  } = useTheme();
  const [specimenId, setSpecimenId] = useState(SPECIMENS[0].id);
  const specimen = SPECIMENS.find((entry) => entry.id === specimenId) ?? SPECIMENS[0];
  const themeOptions = themes.map((entry) => ({ value: entry.id, label: entry.label }));

  return (
    <div className="flex min-h-dvh flex-col bg-background text-foreground">
      <header className="sticky top-0 z-40 border-b border-border bg-background/95 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="font-serif text-title text-foreground">Page layouts</h1>
            <Select value={specimenId} onValueChange={setSpecimenId}>
              <SelectTrigger size="sm" aria-label="Layout">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SPECIMENS.map((entry) => (
                  <SelectItem key={entry.id} value={entry.id}>
                    {entry.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
          </div>
        </div>
        <div className="px-6 pb-3">
          <Measure>
            <p className="text-aux text-muted-foreground">{specimen.usage}</p>
            {specimen.hint ? (
              <p className="mt-1 text-aux text-muted-foreground">{specimen.hint}</p>
            ) : null}
          </Measure>
        </div>
      </header>

      {/* The specimen renders as the whole page, the way a route would. */}
      <main className="flex-1">{specimen.render()}</main>
    </div>
  );
}
