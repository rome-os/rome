import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Item, Row, Section, Specimen } from "../kit";

const SURFACE_TOKENS = [
  "background",
  "chat-canvas",
  "app-canvas",
  "surface",
  "surface-muted",
  "surface-elevated",
  "surface-hover",
] as const;

const INK_TOKENS = ["foreground", "muted-foreground", "subtle-foreground"] as const;

const LINE_TOKENS = ["border", "border-strong", "border-subtle", "input", "ring"] as const;

const ACCENT_TOKENS = ["primary", "secondary", "muted", "accent", "overlay"] as const;

const STATUS_TOKENS = ["destructive", "success", "warning", "info"] as const;

function Swatch({ token }: { token: string }) {
  return (
    <div className="flex w-36 flex-col gap-2">
      <div
        className="h-12 rounded-8 border border-border-subtle"
        style={{ background: `var(--${token})` }}
      />
      <code className="font-mono text-aux text-muted-foreground">--{token}</code>
    </div>
  );
}

function StatusSwatch({ token }: { token: string }) {
  return (
    <div className="flex w-44 flex-col gap-2">
      <div
        className="flex h-12 items-center justify-center rounded-8 border text-aux"
        style={{
          background: `var(--${token}-bg)`,
          color: `var(--${token}-fg)`,
          borderColor: `var(--${token}-border)`,
        }}
      >
        {token}
      </div>
      <code className="font-mono text-aux text-muted-foreground">--{token}-bg / -fg / -border</code>
    </div>
  );
}

/**
 * The typography roles, in scale order. `className` is spelled out rather than
 * built from `name` because Tailwind only emits utilities it can see as
 * literals.
 */
const TYPE_ROLES = [
  { name: "display", className: "text-display", sample: "A stone library at golden hour" },
  { name: "title", className: "text-title", sample: "Today's briefing" },
  { name: "section", className: "text-section", sample: "Access control" },
  { name: "composer", className: "text-composer", sample: "What the chat composer is typed at." },
  { name: "ui", className: "text-ui", sample: "Control labels, list rows, menu items." },
  { name: "badge", className: "text-badge", sample: "Status pills, tags, and counters." },
  { name: "aux", className: "text-aux", sample: "Captions, timestamps, helper text." },
] as const;

/** The control and field steps, read back off the live document. */
const SCALE_ROWS = [
  {
    step: "sm",
    h: "--control-h-sm",
    r: "--control-r-sm",
    spx: "--control-px-start-sm",
    cpx: "--control-px-center-sm",
  },
  {
    step: "md",
    h: "--control-h-md",
    r: "--control-r-md",
    spx: "--control-px-start-md",
    cpx: "--control-px-center-md",
  },
  {
    step: "lg",
    h: "--control-h-lg",
    r: "--control-r-lg",
    spx: "--control-px-start-lg",
    cpx: "--control-px-center-lg",
  },
] as const;

function ControlScaleTable() {
  const [values, setValues] = useState<Record<string, string>>({});

  // Read the resolved values rather than restating them, so this table can
  // never drift from globals.css the way a hand-written one would.
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const next: Record<string, string> = {};
    for (const row of SCALE_ROWS) {
      for (const token of [row.h, row.r, row.spx, row.cpx]) {
        next[token] = style.getPropertyValue(token).trim();
      }
    }
    setValues(next);
  }, []);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-md text-ui">
        <thead>
          <tr className="border-b border-border text-left text-aux text-muted-foreground">
            <th className="py-1 pr-4">Step</th>
            <th className="py-1 pr-4">Height</th>
            <th className="py-1 pr-4">Radius</th>
            <th className="py-1 pr-4">Start padding</th>
            <th className="py-1">Center padding</th>
          </tr>
        </thead>
        <tbody className="font-mono text-aux">
          {SCALE_ROWS.map((row) => (
            <tr key={row.step} className="border-b border-border-subtle last:border-0">
              <td className="py-1 pr-4 text-foreground">{row.step}</td>
              <td className="py-1 pr-4 text-muted-foreground">{values[row.h]}</td>
              <td className="py-1 pr-4 text-muted-foreground">{values[row.r]}</td>
              <td className="py-1 pr-4 text-muted-foreground">{values[row.spx]}</td>
              <td className="py-1 text-muted-foreground">{values[row.cpx]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function FoundationsSection() {
  return (
    <Section
      id="foundations"
      title="Foundations"
      description="Semantic tokens only — every swatch reads a var(), so switching theme or mode above repaints this section without a single per-component rule."
    >
      <Specimen label="Surfaces" note="Canvas, cards, and the sunken and raised tones.">
        <Row className="items-start">
          {SURFACE_TOKENS.map((t) => (
            <Swatch key={t} token={t} />
          ))}
        </Row>
      </Specimen>

      <Specimen label="Ink" note="Foreground ramp, strongest first.">
        <div className="space-y-1">
          {INK_TOKENS.map((t) => (
            <p key={t} className="text-ui" style={{ color: `var(--${t})` }}>
              The quick brown fox — <code className="font-mono text-aux">--{t}</code>
            </p>
          ))}
        </div>
      </Specimen>

      <Specimen label="Lines and accents">
        <Row className="items-start">
          {[...LINE_TOKENS, ...ACCENT_TOKENS].map((t) => (
            <Swatch key={t} token={t} />
          ))}
        </Row>
      </Specimen>

      <Specimen
        label="Status"
        note="Each status ships a -bg / -fg / -border triple for chips plus a solid fill."
      >
        <Row className="items-start">
          {STATUS_TOKENS.map((t) => (
            <StatusSwatch key={t} token={t} />
          ))}
        </Row>
      </Specimen>

      <Specimen
        label="Type roles"
        note="The seven roles are the only way to set type. Each utility carries size, leading, tracking and weight together, so a role never needs a font-medium or a tracking-* beside it. /dev/typography is the deep surface — live values, real locale copy, in-context assemblies."
      >
        <div className="space-y-3">
          {TYPE_ROLES.map((role) => (
            <div
              key={role.name}
              className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1"
            >
              <p className={`${role.className} text-foreground`}>{role.sample}</p>
              <code className="font-mono text-aux text-subtle-foreground">{role.className}</code>
            </div>
          ))}
        </div>
      </Specimen>

      <Specimen
        label="Type families"
        note="Family is orthogonal to role: Petrona (serif) for display moments, Funnel Sans for UI, IBM Plex Mono for code and IDs."
      >
        <div className="space-y-2">
          <p className="font-serif text-display text-foreground">today's briefing</p>
          <p className="text-ui text-foreground">
            Body copy in Funnel Sans. Rome runs the marketing, books, and inbox.
          </p>
          <p className="font-mono text-aux text-muted-foreground">
            ses_01J9Z4KQ3R — font-mono for IDs and code
          </p>
        </div>
      </Specimen>

      <Specimen
        label="Control scale"
        note="The one source of truth for control geometry, read live off the document."
      >
        <div className="space-y-4">
          <ControlScaleTable />
          <div className="rounded-8 border border-border-subtle bg-surface-muted p-3">
            <p className="mb-2 text-aux text-muted-foreground">
              A button, a field and a chip on one row — they line up by construction, not by
              coincidence.
            </p>
            <Row>
              <Input className="w-56" placeholder="Search sessions" />
              <Button>Search</Button>
              <Button variant="outline">Clear</Button>
              <Badge variant="info">12 results</Badge>
            </Row>
          </div>
        </div>
      </Specimen>

      <Specimen label="Radius and elevation">
        <Row className="items-start">
          {(["sm", "md", "lg", "xl"] as const).map((r) => (
            <Item key={r} label={`--radius-${r}`}>
              <div
                className="h-16 w-24 border border-border bg-surface-elevated"
                style={{ borderRadius: `var(--radius-${r})` }}
              />
            </Item>
          ))}
          <Item label="shadow-1">
            <div className="h-16 w-24 rounded-12 border border-border bg-surface-elevated shadow-1" />
          </Item>
          <Item label="shadow-4">
            <div className="h-16 w-24 rounded-12 border border-border bg-surface-elevated shadow-4" />
          </Item>
          <Item label="shadow-10">
            <div className="h-16 w-24 rounded-12 border border-border bg-surface-elevated shadow-10" />
          </Item>
          <Item label="shadow-25">
            <div className="h-16 w-24 rounded-12 border border-border bg-surface-elevated shadow-25" />
          </Item>
          <Item label="shadow-card-hover">
            <div className="h-16 w-24 rounded-12 border border-border bg-surface-elevated shadow-card-hover" />
          </Item>
        </Row>
      </Specimen>
    </Section>
  );
}
