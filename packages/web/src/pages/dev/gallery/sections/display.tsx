import { useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Inbox,
  Info,
  Search,
  Sparkles,
  TriangleAlert,
} from "lucide-react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@rome-os/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateAction,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@rome-os/ui/empty-state";
import {
  Avatar,
  AvatarBadge,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
} from "@/components/ui/avatar";
import { Spinner } from "@rome-os/ui/spinner";
import { Timestamp, TimestampProvider } from "@rome-os/ui/timestamp";
import { Markdown } from "@rome-os/ui/markdown";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tile } from "@/components/ui/tile";
import { getBuiltinMermaidTheme } from "@/components/markdown";
import { useTheme } from "@/hooks/use-theme";
import { Component, Item, Row, Section, Specimen } from "../kit";

const BADGE_VARIANTS = [
  "default",
  "info",
  "success",
  "warning",
  "brand",
  "destructive",
  "muted",
  "outline",
] as const;

// One instant for the layout and zone specimens: late enough in the UTC day
// that Tokyo and New York disagree on the date.
const SAMPLE_INSTANT = "2026-09-03T15:04:05Z";

const RELATIVE_OFFSETS: ReadonlyArray<readonly [label: string, offsetMs: number]> = [
  ["30 seconds ago", -30_000],
  ["5 minutes ago", -5 * 60_000],
  ["3 hours ago", -3 * 3_600_000],
  ["30 hours ago", -30 * 3_600_000],
  ["12 days ago", -12 * 86_400_000],
  ["in 2 hours", 2 * 3_600_000],
  ["in 400 days", 400 * 86_400_000],
];

const ROWS = [
  { id: "ses_01J9Z4", app: "Bookkeeper", status: "Done", duration: "1m 04s" },
  { id: "ses_01J9Z5", app: "Marketer", status: "Running", duration: "12s" },
  { id: "ses_01J9Z6", app: "Inbox", status: "Failed", duration: "3m 41s" },
];

export function DisplaySection() {
  const [selectedTile, setSelectedTile] = useState("private");
  const [mountedAt] = useState(() => Date.now());
  // Prose paints from inherited tokens on its own; Mermaid is the one part that
  // needs handing an explicit sRGB palette, because its color parser can't read
  // the OKLCH primitives Slate and Ember dark are built on.
  const { theme, resolved } = useTheme();
  const mermaidTheme = getBuiltinMermaidTheme(theme, resolved);

  return (
    <Section
      id="display"
      title="Display"
      description="Containers and read-only surfaces — panels, chips, callouts, tables and the pieces that carry status."
    >
      <Component id="card" name="Card" source="@rome-os/ui/card">
        {/* On `background`, because that is what a dashboard panel sits on —
            inside the specimen's own `surface` fill the card's fill would be
            invisible and the comparison below would prove nothing. */}
        <Specimen
          label="Card — anatomy"
          note="Header, content and footer pad horizontally; the Card owns the vertical inset and the gap between them. CardAction takes its own cell beside the title."
          className="bg-background"
        >
          <Card className="max-w-md">
            <CardHeader>
              <CardTitle>Delivery</CardTitle>
              <CardDescription>Where your briefing lands each morning.</CardDescription>
              <CardAction>
                <Badge variant="success">On</Badge>
              </CardAction>
            </CardHeader>
            <CardContent className="text-ui text-muted-foreground">
              Sent to Telegram at 7:00, in your local timezone.
            </CardContent>
            <CardFooter>
              <Button size="sm" variant="secondary">
                Change
              </Button>
            </CardFooter>
          </Card>
        </Specimen>

        <Specimen
          label="Card — ruled header"
          note="A header that carries border-b restores its own bottom padding, so the rule sits at the section edge without a per-site pb-*."
          className="bg-background"
        >
          <Card className="max-w-md">
            <CardHeader className="border-b border-border-subtle">
              <CardTitle>Manage</CardTitle>
            </CardHeader>
            <CardContent className="text-ui text-muted-foreground">
              The app-detail idiom: a titled band, then rows.
            </CardContent>
          </Card>
        </Specimen>

        <Specimen
          label="Card — against the panel it replaces"
          note="Left: the hand-rolled idiom from SettingsTabPage using the same typography roles as Card. Right: the same panel composed from Card. They should be indistinguishable in every theme × mode."
          className="bg-background"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <section className="rounded-12 border border-border bg-surface p-4">
              <h3 className="text-section text-foreground">Allowed accounts</h3>
              <p className="mt-1 text-body text-muted-foreground">
                Google accounts that may sign in from the cloud.
              </p>
              <p className="mt-4 text-ui text-muted-foreground">2 accounts</p>
            </section>

            <Card>
              <CardHeader>
                <CardTitle>Allowed accounts</CardTitle>
                <CardDescription>Google accounts that may sign in from the cloud.</CardDescription>
              </CardHeader>
              <CardContent className="text-ui text-muted-foreground">2 accounts</CardContent>
            </Card>
          </div>
        </Specimen>
      </Component>

      <Component id="empty-state" name="EmptyState" source="@rome-os/ui/empty-state">
        <Specimen
          label="EmptyState — empty, no results and loading"
          note="The panel keeps an intrinsic minimum height; add h-full only when its parent owns the height. Loading composes the same anatomy with Spinner rather than a boolean variant."
        >
          <div className="grid gap-4 lg:grid-cols-3">
            <EmptyState className="rounded-12 border border-dashed border-border">
              <EmptyStateIcon>
                <Inbox aria-hidden />
              </EmptyStateIcon>
              <EmptyStateTitle>No briefings yet</EmptyStateTitle>
              <EmptyStateDescription>
                Your completed morning and evening briefings will appear here.
              </EmptyStateDescription>
              <EmptyStateAction>
                <Button size="sm">Create briefing</Button>
              </EmptyStateAction>
            </EmptyState>

            <EmptyState className="rounded-12 border border-dashed border-border">
              <EmptyStateIcon>
                <Search aria-hidden />
              </EmptyStateIcon>
              <EmptyStateTitle>No apps match “weather”</EmptyStateTitle>
              <EmptyStateDescription>
                Try a different name or clear the search.
              </EmptyStateDescription>
              <EmptyStateAction>
                <Button size="sm" variant="outline">
                  Clear search
                </Button>
              </EmptyStateAction>
            </EmptyState>

            <EmptyState className="rounded-12 border border-dashed border-border">
              <EmptyStateIcon>
                <Spinner label="Loading activity" />
              </EmptyStateIcon>
              <EmptyStateTitle>Loading activity</EmptyStateTitle>
              <EmptyStateDescription>Fetching the latest runs and approvals.</EmptyStateDescription>
            </EmptyState>
          </div>
        </Specimen>
      </Component>

      <Component id="badge" name="Badge" source="@rome-os/ui/badge">
        <Specimen label="Badge — variants" note="22px tall, sized from --badge-*.">
          <Row>
            {BADGE_VARIANTS.map((variant) => (
              <Item key={variant} label={variant}>
                <Badge variant={variant}>{variant}</Badge>
              </Item>
            ))}
          </Row>
        </Specimen>

        <Specimen label="Badge — shapes and content">
          <Row>
            <Item label="pill (default)">
              <Badge variant="success">Filed</Badge>
            </Item>
            <Item label="square">
              <Badge variant="info" shape="square">
                Draft
              </Badge>
            </Item>
            <Item label="with a dot">
              <Badge variant="warning">
                <span className="size-1.5 rounded-full bg-warning-fg" aria-hidden />
                Needs you
              </Badge>
            </Item>
            <Item label="with an icon">
              <Badge variant="brand">
                <Sparkles aria-hidden />
                Rome Cloud
              </Badge>
            </Item>
            <Item label="asChild — a badge that navigates">
              <Badge asChild variant="outline">
                <a href="https://github.com/amantru/rome-internal/pull/1234">#1234</a>
              </Badge>
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="alert" name="Alert" source="@rome-os/ui/alert">
        <Specimen label="Alert" note="An inline callout with role=alert — not a toast.">
          <div className="space-y-3">
            <Alert>
              <AlertTitle>Quiet day</AlertTitle>
              <AlertDescription>
                Nothing in the queue. Want to brief a new project?
              </AlertDescription>
            </Alert>
            <Alert variant="info">
              <Info aria-hidden />
              <AlertTitle>Three drafts are waiting</AlertTitle>
              <AlertDescription>The marketer finished the Friday newsletter.</AlertDescription>
            </Alert>
            <Alert variant="success">
              <CheckCircle2 aria-hidden />
              <AlertTitle>Filed in books</AlertTitle>
              <AlertDescription>Twelve receipts, reconciled against the ledger.</AlertDescription>
            </Alert>
            <Alert variant="warning">
              <TriangleAlert aria-hidden />
              <AlertTitle>Your Stripe connection expires in three days</AlertTitle>
              <AlertDescription>Re-connect it and the bookkeeper carries on.</AlertDescription>
            </Alert>
            <Alert variant="destructive">
              <AlertTriangle aria-hidden />
              <AlertTitle>I couldn't reach your Stripe account</AlertTitle>
              <AlertDescription>Re-connect it and I'll try again.</AlertDescription>
            </Alert>
          </div>
        </Specimen>
      </Component>

      <Component id="avatar" name="Avatar" source="ui/avatar.tsx">
        <Specimen label="Avatar">
          <Row>
            <Item label="fallback">
              <Avatar>
                <AvatarFallback>AO</AvatarFallback>
              </Avatar>
            </Item>
            <Item label="with badge">
              <Avatar>
                <AvatarFallback>RM</AvatarFallback>
                <AvatarBadge className="bg-success" />
              </Avatar>
            </Item>
            <Item label="group">
              <AvatarGroup>
                <Avatar>
                  <AvatarFallback>AO</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>RM</AvatarFallback>
                </Avatar>
                <Avatar>
                  <AvatarFallback>KT</AvatarFallback>
                </Avatar>
                <AvatarGroupCount>+3</AvatarGroupCount>
              </AvatarGroup>
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="tile" name="Tile" source="ui/tile.tsx">
        <Specimen label="Tile" note="Selectable card — aria-pressed, not a radio.">
          <Row className="items-stretch">
            {[
              { id: "private", title: "Private", description: "Only you can reach this app." },
              { id: "public", title: "Public", description: "Anyone with the link." },
              { id: "cloud", title: "Rome Cloud", description: "Hosted and kept up to date." },
            ].map((tile) => (
              <Tile
                key={tile.id}
                className="w-56"
                icon={<Sparkles className="size-4" aria-hidden />}
                title={tile.title}
                description={tile.description}
                selected={selectedTile === tile.id}
                onClick={() => setSelectedTile(tile.id)}
              />
            ))}
          </Row>
        </Specimen>
      </Component>

      <Component id="table" name="Table" source="ui/table.tsx">
        <Specimen label="Table">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Session</TableHead>
                <TableHead>App</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Duration</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ROWS.map((row) => (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-aux">{row.id}</TableCell>
                  <TableCell>{row.app}</TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        row.status === "Done"
                          ? "success"
                          : row.status === "Failed"
                            ? "destructive"
                            : "info"
                      }
                    >
                      {row.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">{row.duration}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Specimen>
      </Component>

      <Component id="separator" name="Separator" source="@rome-os/ui/separator">
        <Specimen label="Separator">
          <div className="space-y-3">
            <p className="text-ui text-muted-foreground">Above</p>
            <Separator />
            <p className="text-ui text-muted-foreground">Below</p>
            <Row className="h-8">
              <span className="text-ui text-muted-foreground">Left</span>
              <Separator orientation="vertical" />
              <span className="text-ui text-muted-foreground">Right</span>
            </Row>
          </div>
        </Specimen>
      </Component>

      <Component id="skeleton" name="Skeleton" source="@rome-os/ui/skeleton">
        <Specimen label="Skeleton">
          <div className="max-w-md space-y-2">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-1/2" />
            <Row className="pt-2">
              <Skeleton className="size-10 rounded-full" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-3 w-1/3" />
                <Skeleton className="h-3 w-1/4" />
              </div>
            </Row>
          </div>
        </Specimen>
      </Component>

      <Component id="spinner" name="Spinner" source="@rome-os/ui/spinner">
        <Specimen
          label="Spinner — sizes"
          note="sm and md match the icon slot of the control step they sit beside. No color prop: the glyph strokes in currentColor."
        >
          <Row>
            <Item label="sm">
              <Spinner size="sm" />
            </Item>
            <Item label="md (default)">
              <Spinner />
            </Item>
            <Item label="in muted text">
              <span className="text-muted-foreground">
                <Spinner />
              </span>
            </Item>
            <Item label="resized by the caller">
              <Spinner className="size-8" />
            </Item>
          </Row>
        </Specimen>

        <Specimen
          label="Spinner — inside a control"
          note="A Spinner is composed into a Button rather than switched on by a prop: the caller already passes disabled, and the spinner is exactly as wide as the icon it replaces, so the button doesn't resize mid-wait."
        >
          <Row>
            <Item label="sm — replacing the icon">
              <Button size="sm" disabled>
                <Spinner size="sm" />
                Installing
              </Button>
            </Item>
            <Item label="md — destructive tone">
              <Button variant="destructive" disabled>
                <Spinner />
                Deleting
              </Button>
            </Item>
            <Item label="icon-only">
              <Button size="icon-sm" variant="ghost" disabled>
                <Spinner size="sm" label="Refreshing" />
              </Button>
            </Item>
            <Item label="beside a field">
              <Row className="gap-2">
                <Input className="w-48" placeholder="Repository URL" readOnly />
                <Spinner label="Checking repository" />
              </Row>
            </Item>
          </Row>
        </Specimen>
      </Component>

      <Component id="timestamp" name="Timestamp" source="@rome-os/ui/timestamp">
        <Specimen
          label="Timestamp — relative"
          note="The default layout. Each label re-renders on its own at the moment its wording changes; hover for the exact instant. The offsets are from when this page mounted."
        >
          <Row>
            {RELATIVE_OFFSETS.map(([label, offset]) => (
              <Item key={label} label={label}>
                <Timestamp value={mountedAt + offset} />
              </Item>
            ))}
          </Row>
        </Specimen>
        <Specimen
          label="Timestamp — layouts"
          note="One instant in every preset, plus raw Intl options for anything the presets lack."
        >
          <Row>
            <Item label="time">
              <Timestamp value={SAMPLE_INSTANT} format="time" />
            </Item>
            <Item label="date">
              <Timestamp value={SAMPLE_INSTANT} format="date" />
            </Item>
            <Item label="datetime">
              <Timestamp value={SAMPLE_INSTANT} format="datetime" />
            </Item>
            <Item label="full">
              <Timestamp value={SAMPLE_INSTANT} format="full" />
            </Item>
            <Item label="{ weekday, hour }">
              <Timestamp value={SAMPLE_INSTANT} format={{ weekday: "short", hour: "numeric" }} />
            </Item>
            <Item label="null → fallback">
              <Timestamp value={null} />
            </Item>
          </Row>
        </Specimen>
        <Specimen
          label="Timestamp — zones"
          note="The same instant under a provider set to Tokyo. A prop overrides the provider for one element; the last one shows the browser's own zone."
        >
          <TimestampProvider timeZone="Asia/Tokyo">
            <Row>
              <Item label="provider · Asia/Tokyo">
                <Timestamp value={SAMPLE_INSTANT} format="datetime" />
              </Item>
              <Item label="prop · America/New_York">
                <Timestamp value={SAMPLE_INSTANT} format="datetime" timeZone="America/New_York" />
              </Item>
              <Item label="prop · browser zone">
                <Timestamp
                  value={SAMPLE_INSTANT}
                  format="datetime"
                  timeZone={Intl.DateTimeFormat().resolvedOptions().timeZone}
                />
              </Item>
            </Row>
          </TimestampProvider>
        </Specimen>
      </Component>

      <Component id="markdown" name="Markdown" source="@rome-os/ui/markdown">
        <Specimen
          label="Markdown — prose, code, math, diagram"
          note="Streamdown with the Shiki, KaTeX and Mermaid plugins. Everything paints from inherited semantic tokens, so switching theme or mode above repaints it — Mermaid included, via the explicit sRGB palette the host passes through `theme`."
        >
          <Markdown theme={mermaidTheme}>{MARKDOWN_SPECIMEN}</Markdown>
        </Specimen>

        <Specimen
          label="Markdown — compact and standard token bindings"
          note="Markdown owns its typography and rhythm tokens. compact rebinds those same semantic tokens to the dense scale without changing the rendered element roles."
        >
          <Row className="items-start gap-6">
            <Item label="compact">
              <div className="w-64">
                <Markdown compact>{MARKDOWN_COMPACT_SPECIMEN}</Markdown>
              </div>
            </Item>
            <Item label="standard">
              <div className="w-64">
                <Markdown>{MARKDOWN_COMPACT_SPECIMEN}</Markdown>
              </div>
            </Item>
          </Row>
        </Specimen>
      </Component>
    </Section>
  );
}

const MARKDOWN_SPECIMEN = `## Deploying a briefing

Rome sends the brief **after** the agent turn settles, so a late tool result
still lands in the same message. Read the [delivery contract](https://rome.dev/docs).

- Channel policy decides the surface
- \`sentinel\` decides whether it needs approval

\`\`\`ts
export async function deliver(brief: Brief, to: ChannelId) {
  const policy = await resolvePolicy(to);
  return policy.requiresApproval ? queue(brief) : send(brief, to);
}
\`\`\`

The retry budget is $$b = \\lceil \\log_2(t_{max} / t_0) \\rceil$$ attempts.

\`\`\`mermaid
graph LR
  Turn --> Sentinel
  Sentinel -->|approved| Channel
  Sentinel -->|held| Queue
\`\`\`

> A held brief keeps its original timestamp, not the approval's.
`;

const MARKDOWN_COMPACT_SPECIMEN = `### Retry budget

Backoff doubles per attempt, capped at \`t_max\`.

1. Send
2. Wait \`t_0 * 2^n\`
3. Give up at the cap
`;
