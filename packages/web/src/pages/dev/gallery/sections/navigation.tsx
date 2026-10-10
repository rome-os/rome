import { useState } from "react";
import { AlignLeft, Braces, Calendar, Rows3, Table as TableIcon } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SegmentedControl, type SegmentedControlOption } from "@/components/ui/segmented-control";
import { FilterChipGroup, type FilterChipOption } from "@/components/ui/filter-chip-group";
import {
  Breadcrumb,
  BreadcrumbEllipsis,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Stepper } from "@/components/ui/stepper";
import { Component, Item, Row, Section, Specimen } from "../kit";

const VIEW_OPTIONS = [
  { value: "table", label: "Table", icon: <TableIcon aria-hidden /> },
  { value: "calendar", label: "Calendar", icon: <Calendar aria-hidden /> },
  { value: "timeline", label: "Timeline", icon: <AlignLeft aria-hidden /> },
];

const PLAIN_OPTIONS = [
  { value: "overview", label: "Overview" },
  { value: "sessions", label: "Sessions" },
];

// Union-typed options: `onValueChange` hands back `EpicFilter`, not `string`.
type EpicFilter = "all" | "open" | "archived";

const EPIC_OPTIONS: SegmentedControlOption<EpicFilter>[] = [
  { value: "all", label: "All", title: "Every epic, whatever its state" },
  { value: "open", label: "Open", title: "Only epics with unfinished work" },
  { value: "archived", label: "Archived", title: "Epics closed out of the board" },
];

// Union-typed here too: `onValueChange` hands back `Bond`, not `string`.
type Bond = "all" | "inner-circle" | "acquaintance" | "other";

const BOND_OPTIONS: FilterChipOption<Bond>[] = [
  { value: "all", label: "All", count: 128 },
  { value: "inner-circle", label: "Inner circle", count: 6 },
  { value: "acquaintance", label: "Acquaintance", count: 24 },
  { value: "other", label: "Other", count: 98 },
];

const OVERFLOW_OPTIONS = [
  { value: "all", label: "All", count: 212 },
  { value: "billing", label: "Billing", count: 18 },
  { value: "onboarding", label: "Onboarding", count: 41 },
  { value: "infrastructure", label: "Infrastructure", count: 76 },
  { value: "design-system", label: "Design system", count: 33 },
  { value: "documentation", label: "Documentation", count: 44 },
];

export function NavigationSection() {
  const [view, setView] = useState("table");
  const [scope, setScope] = useState("overview");
  const [width, setWidth] = useState("all");
  const [smallScope, setSmallScope] = useState("json");
  const [epicFilter, setEpicFilter] = useState<EpicFilter>("open");
  const [bond, setBond] = useState<Bond>("all");
  const [channel, setChannel] = useState("all");
  const [overflow, setOverflow] = useState("all");
  const [state, setState] = useState("open");
  const [step, setStep] = useState(1);

  return (
    <Section
      id="navigation"
      title="Navigation"
      description="Tabs and SegmentedControl look related but answer different questions. Pick by whether each choice owns a panel."
    >
      <Component id="tabs" name="Tabs" source="@rome-os/ui/tabs">
        <Specimen
          label="Tabs"
          note="Underline only. Each trigger reveals its own TabsContent — that is the tablist/tabpanel contract."
        >
          <Tabs defaultValue="recent">
            <TabsList aria-label="Activity">
              <TabsTrigger value="recent">Recent</TabsTrigger>
              <TabsTrigger value="routines">Routines</TabsTrigger>
              <TabsTrigger value="archive" disabled>
                Archive
              </TabsTrigger>
            </TabsList>
            <TabsContent value="recent" className="pt-3 text-ui text-muted-foreground">
              The activity feed lives here — this panel belongs to the Recent tab.
            </TabsContent>
            <TabsContent value="routines" className="pt-3 text-ui text-muted-foreground">
              A different panel, owned by the Routines tab.
            </TabsContent>
          </Tabs>
        </Specimen>

        <Specimen
          label="Tabs with a glyph"
          note="A trigger names no size — its list sits between the shared heights — so the glyph takes the same sm step the label already pads on: 14px."
        >
          <Tabs defaultValue="table">
            <TabsList aria-label="Routines view">
              <TabsTrigger value="table">
                <TableIcon aria-hidden />
                Table
              </TabsTrigger>
              <TabsTrigger value="calendar">
                <Calendar aria-hidden />
                Calendar
              </TabsTrigger>
              <TabsTrigger value="timeline">
                <AlignLeft aria-hidden />
                Timeline
              </TabsTrigger>
            </TabsList>
            <TabsContent value="table" className="pt-3 text-ui text-muted-foreground">
              The same three views the SegmentedControl below offers, so the two treatments of one
              glyph sit on one page.
            </TabsContent>
            <TabsContent value="calendar" className="pt-3 text-ui text-muted-foreground">
              A month grid would live here.
            </TabsContent>
            <TabsContent value="timeline" className="pt-3 text-ui text-muted-foreground">
              A time-ordered list would live here.
            </TabsContent>
          </Tabs>
        </Specimen>
      </Component>

      <Component
        id="segmented-control"
        name="SegmentedControl"
        source="@rome-os/ui/segmented-control"
      >
        <Specimen
          label="SegmentedControl"
          note="A radiogroup, not a tablist. Use it when the choice switches, filters or reframes one view rather than revealing a panel."
        >
          <div className="space-y-4">
            <Item label={`md — value: ${view}`}>
              <SegmentedControl
                aria-label="Routines view"
                options={VIEW_OPTIONS}
                value={view}
                onValueChange={setView}
              />
            </Item>
            <Item label={`sm — value: ${smallScope}`}>
              <SegmentedControl
                aria-label="Input mode"
                size="sm"
                options={[
                  { value: "json", label: "Paste JSON", icon: <Braces aria-hidden /> },
                  { value: "fields", label: "Key / Value", icon: <Rows3 aria-hidden /> },
                ]}
                value={smallScope}
                onValueChange={setSmallScope}
              />
            </Item>
            <Item label={`plain labels — value: ${scope}`}>
              <SegmentedControl
                aria-label="Sessions view"
                options={PLAIN_OPTIONS}
                value={scope}
                onValueChange={setScope}
              />
            </Item>
            <Item label="with a disabled segment">
              <SegmentedControl
                aria-label="Scope"
                options={[
                  { value: "all", label: "All" },
                  { value: "mine", label: "Mine" },
                  { value: "archived", label: "Archived", disabled: true },
                ]}
                value={width}
                onValueChange={setWidth}
              />
            </Item>
            <Item label="disabled group">
              <SegmentedControl
                aria-label="Scope"
                disabled
                options={[
                  { value: "all", label: "All" },
                  { value: "mine", label: "Mine" },
                ]}
                value={width}
                onValueChange={setWidth}
              />
            </Item>
            <Item label="explained segments — hover or tab onto one">
              <SegmentedControl
                aria-label="Epic filter"
                options={EPIC_OPTIONS}
                value={epicFilter}
                onValueChange={setEpicFilter}
              />
            </Item>
          </div>
        </Specimen>
      </Component>

      <Component
        id="filter-chip-group"
        name="FilterChipGroup"
        source="@rome-os/ui/filter-chip-group"
      >
        <Specimen
          label="FilterChipGroup"
          note="The other one-of-N radiogroup. SegmentedControl is a fixed track for a few known views; this is a data-driven option set that scrolls rather than compresses, and sits above the rows it filters."
        >
          <div className="space-y-4">
            <Item label={`with counts — value: ${bond}`}>
              <FilterChipGroup
                aria-label="Filter people by bond"
                options={BOND_OPTIONS}
                value={bond}
                onValueChange={setBond}
              />
            </Item>
            <Item label={`no counts — value: ${channel}`}>
              <FilterChipGroup
                aria-label="Filter by channel"
                options={[
                  { value: "all", label: "All" },
                  { value: "telegram", label: "Telegram" },
                  { value: "whatsapp", label: "WhatsApp" },
                ]}
                value={channel}
                onValueChange={setChannel}
              />
            </Item>
            <Item label="overflowing — the row scrolls, the chips keep their size">
              <div className="max-w-sm">
                <FilterChipGroup
                  aria-label="Filter by label"
                  options={OVERFLOW_OPTIONS}
                  value={overflow}
                  onValueChange={setOverflow}
                />
              </div>
            </Item>
            <Item label="with a disabled chip">
              <FilterChipGroup
                aria-label="Filter by state"
                options={[
                  { value: "all", label: "All", count: 9 },
                  { value: "open", label: "Open", count: 4 },
                  { value: "archived", label: "Archived", count: 0, disabled: true },
                ]}
                value={state}
                onValueChange={setState}
              />
            </Item>
          </div>
        </Specimen>
      </Component>

      <Component id="breadcrumb" name="Breadcrumb" source="ui/breadcrumb.tsx">
        <Specimen label="Breadcrumb">
          <Breadcrumb>
            <BreadcrumbList>
              <BreadcrumbItem>
                <BreadcrumbLink href="#navigation">Projects</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href="#navigation">Ash & Oak</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>Ledger</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Specimen>
        <Specimen
          label="Collapsed"
          note="`collapseBreadcrumb` keeps the first crumb and the deepest ones; the ellipsis lists the rest."
        >
          <Breadcrumb>
            <BreadcrumbList className="font-mono text-aux">
              <BreadcrumbItem>
                <BreadcrumbLink href="#navigation">Files</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <BreadcrumbEllipsis label="Show 3 hidden folders" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" sideOffset={4}>
                    <DropdownMenuItem>projects</DropdownMenuItem>
                    <DropdownMenuItem>ash-and-oak</DropdownMenuItem>
                    <DropdownMenuItem>ledger</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbLink href="#navigation">2026</BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator />
              <BreadcrumbItem>
                <BreadcrumbPage>q3-invoices</BreadcrumbPage>
              </BreadcrumbItem>
            </BreadcrumbList>
          </Breadcrumb>
        </Specimen>
      </Component>

      <Component id="stepper" name="Stepper" source="ui/stepper.tsx">
        <Specimen label="Stepper" note="0-based `current`; earlier steps render complete.">
          <div className="space-y-4">
            <Stepper steps={["Account", "Profile", "Channels"]} current={step} />
            <Row>
              <SegmentedControl
                aria-label="Stepper position"
                size="sm"
                options={[
                  { value: "0", label: "Step 1" },
                  { value: "1", label: "Step 2" },
                  { value: "2", label: "Step 3" },
                ]}
                value={String(step)}
                onValueChange={(v) => setStep(Number(v))}
              />
            </Row>
          </div>
        </Specimen>
      </Component>
    </Section>
  );
}
