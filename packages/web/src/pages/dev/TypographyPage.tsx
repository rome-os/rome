import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import i18n from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useTheme } from "@/hooks/use-theme";
import { DEFAULT_THEME_NAME, type ThemePreference } from "@/lib/theme";

// Dev-only typography specimen. Renders every role at its live values — the
// page imports nothing but the role utility classes, and every number shown in
// the spec table is read back from the rendered element via getComputedStyle,
// so editing a role definition in `@rome-os/ui`'s styles.css changes this page
// with no other edit. Sample copy comes from the real locale files (en +
// zh-CN via fixed-language translators, independent of the app language), so
// before/after comparisons over time measure typography, not content.
//
// There is no per-script variant: leading is not a semantic choice a call site
// can make (Rome's surfaces are bilingual within a single element), so Chinese
// copy renders with the same role as English.

// The kit deliberately doesn't export its `TYPOGRAPHY_ROLES` list (it isn't
// published API), so the specimen carries its own copy — and
// `TypographyPage.test.ts` asserts it stays equal to the roles the kit
// stylesheet actually declares, in both directions.
export const ROLES = ["display", "title", "section", "composer", "ui", "badge", "aux"] as const;
type Role = (typeof ROLES)[number];

// Literal class names so Tailwind's scanner sees them (a computed
// `text-${role}` template would not be picked up).
export const ROLE_CLASS: Record<Role, string> = {
  display: "text-display",
  title: "text-title",
  section: "text-section",
  composer: "text-composer",
  ui: "text-ui",
  badge: "text-badge",
  aux: "text-aux",
};

// Fixed-language translators: the page shows both languages at once, so it
// cannot depend on the app's active language.
const en = (ns: string) => i18n.getFixedT("en", ns);
const zh = (ns: string) => i18n.getFixedT("zh-CN", ns);

type Spec = {
  fontSize: string;
  lineHeight: string;
  leadingRatio: string;
  letterSpacing: string;
  fontWeight: string;
};

function readSpec(el: HTMLElement): Spec {
  const cs = getComputedStyle(el);
  const size = Number.parseFloat(cs.fontSize);
  const lh = Number.parseFloat(cs.lineHeight);
  return {
    fontSize: cs.fontSize,
    lineHeight: cs.lineHeight,
    leadingRatio: size > 0 && Number.isFinite(lh) ? (lh / size).toFixed(3) : "—",
    letterSpacing: cs.letterSpacing,
    fontWeight: cs.fontWeight,
  };
}

function specsEqual(a: Spec, b: Spec): boolean {
  return (
    a.fontSize === b.fontSize &&
    a.lineHeight === b.lineHeight &&
    a.letterSpacing === b.letterSpacing &&
    a.fontWeight === b.fontWeight
  );
}

/**
 * Measures the element behind `ref` and keeps the numbers fresh. Re-measures
 * after every render (preview overrides re-render the tree) and on a slow
 * interval so an out-of-band stylesheet edit — Vite CSS HMR after changing a
 * role definition — updates the readout without a reload. The equality guard
 * keeps the render → effect → setState loop from spinning.
 */
function useLiveSpec(ref: React.RefObject<HTMLElement | null>): Spec | null {
  const [spec, setSpec] = useState<Spec | null>(null);
  useEffect(() => {
    const measure = () => {
      if (!ref.current) return;
      const next = readSpec(ref.current);
      setSpec((prev) => (prev && specsEqual(prev, next) ? prev : next));
    };
    measure();
    const id = window.setInterval(measure, 500);
    return () => window.clearInterval(id);
  });
  return spec;
}

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4">
      <div>
        <h2 className="text-title text-foreground">{title}</h2>
        {note ? <p className="mt-1 max-w-2xl text-aux text-muted-foreground">{note}</p> : null}
      </div>
      {children}
    </section>
  );
}

function SpecRow({ role }: { role: Role }) {
  const probeRef = useRef<HTMLSpanElement>(null);
  const spec = useLiveSpec(probeRef);
  return (
    <tr className="border-b border-border-subtle">
      <td className="py-2 pr-4 align-baseline">
        <code className="text-aux text-muted-foreground">{ROLE_CLASS[role]}</code>
      </td>
      <td className="py-2 pr-4 align-baseline">
        <span ref={probeRef} className={`${ROLE_CLASS[role]} text-foreground`}>
          Almost 排版 09:41
        </span>
      </td>
      <td className="py-2 pr-4 text-right align-baseline text-aux tabular-nums text-foreground">
        {spec?.fontSize ?? "—"}
      </td>
      <td className="py-2 pr-4 text-right align-baseline text-aux tabular-nums text-foreground">
        {spec ? `${spec.lineHeight} (${spec.leadingRatio})` : "—"}
      </td>
      <td className="py-2 pr-4 text-right align-baseline text-aux tabular-nums text-foreground">
        {spec?.letterSpacing ?? "—"}
      </td>
      <td className="py-2 text-right align-baseline text-aux tabular-nums text-foreground">
        {spec?.fontWeight ?? "—"}
      </td>
    </tr>
  );
}

function SpecTable() {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-left">
        <thead>
          <tr className="border-b border-border">
            {["Role", "Sample", "Size", "Line height (ratio)", "Tracking", "Weight"].map(
              (header, index) => (
                <th
                  key={header}
                  className={`py-2 pr-4 text-aux text-muted-foreground ${
                    index >= 2 ? "text-right" : ""
                  }`}
                >
                  {header}
                </th>
              ),
            )}
          </tr>
        </thead>
        <tbody>
          {ROLES.map((role) => (
            <SpecRow key={role} role={role} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

type RoleSampleDef = {
  role: Role;
  label: string;
  note?: string;
  lines: { lang: "en" | "zh"; text: string; className?: string }[];
};

function buildRoleSamples(): RoleSampleDef[] {
  const enChat = en("chat");
  const zhChat = zh("chat");
  const enCommon = en("common");
  const zhCommon = zh("common");
  return [
    {
      role: "display",
      label: "Display",
      note: "Hero / empty-state greeting. The home headline itself is currently a bespoke serif size in ChatEmptyState, shown in the assembly below.",
      lines: [
        {
          lang: "en",
          text: `${enChat("empty.greeting", { name: "Ada" })} ${enChat("empty.headline")}`,
        },
        {
          lang: "zh",
          text: `${zhChat("empty.greeting", { name: "安" })} ${zhChat("empty.headline")}`,
        },
      ],
    },
    {
      role: "title",
      label: "Title",
      lines: [
        { lang: "en", text: enCommon("recentChats.deleteConfirm") },
        { lang: "zh", text: zhCommon("recentChats.deleteConfirm") },
      ],
    },
    {
      role: "composer",
      label: "Composer",
      note: "The chat composer only. Its 16px matches the message the composer produces, which Markdown renders at the same size — every other surface reads UI. Chinese renders with the same role; there is no CJK leading variant.",
      lines: [
        { lang: "en", text: enChat("composer.placeholderDefault") },
        { lang: "zh", text: zhChat("composer.placeholderDefault") },
        { lang: "en", text: enChat("composer.placeholderWithUploads") },
        { lang: "zh", text: zhChat("composer.placeholderWithUploads") },
      ],
    },
    {
      role: "ui",
      label: "UI Item",
      lines: [
        {
          lang: "en",
          text: ["chat", "activity", "people", "projects", "apps", "store", "settings"]
            .map((key) => enCommon(`nav.${key}`))
            .join("   "),
        },
        {
          lang: "zh",
          text: ["chat", "activity", "people", "projects", "apps", "store", "settings"]
            .map((key) => zhCommon(`nav.${key}`))
            .join("   "),
        },
      ],
    },
    {
      role: "aux",
      label: "Auxiliary",
      lines: [
        {
          lang: "en",
          text: [
            ...["today", "yesterday", "previous7Days", "previous30Days", "older"].map((key) =>
              enCommon(`recentChats.groups.${key}`),
            ),
            enCommon("recentChats.searchResultsCount", { count: 12 }),
            enCommon("recentChats.loadMore", { count: 20 }),
          ].join("   "),
        },
        {
          lang: "zh",
          text: [
            ...["today", "yesterday", "previous7Days", "previous30Days", "older"].map((key) =>
              zhCommon(`recentChats.groups.${key}`),
            ),
            zhCommon("recentChats.searchResultsCount", { count: 12 }),
            zhCommon("recentChats.loadMore", { count: 20 }),
          ].join("   "),
        },
      ],
    },
  ];
}

function RoleSample({ def }: { def: RoleSampleDef }) {
  return (
    <div className="flex flex-col gap-2 border-b border-border-subtle pb-6">
      <div className="flex items-baseline gap-3">
        <h3 className="text-ui text-foreground">{def.label}</h3>
        <code className="text-aux text-muted-foreground">{ROLE_CLASS[def.role]}</code>
      </div>
      {def.note ? <p className="max-w-2xl text-aux text-muted-foreground">{def.note}</p> : null}
      <div className="flex max-w-3xl flex-col gap-2">
        {def.lines.map((line) => (
          <p
            key={`${line.lang}-${line.text.slice(0, 24)}`}
            lang={line.lang === "zh" ? "zh-CN" : "en"}
            className={`${ROLE_CLASS[def.role]} text-foreground ${line.className ?? ""}`}
          >
            {line.text}
          </p>
        ))}
      </div>
    </div>
  );
}

/**
 * Sidebar sample mirroring RecentChats' real classes: `text-aux
 * text-subtle-foreground` group headers over `h-8 … text-ui` rows, with a
 * right-aligned timestamp column added for the digit-alignment check. Row
 * titles alternate English and Chinese locale strings so adjacent scripts sit
 * on the same rhythm.
 */
function SidebarSample() {
  const enCommon = en("common");
  const zhCommon = zh("common");
  const enChat = en("chat");
  const zhChat = zh("chat");
  const enApps = en("apps");
  const zhApps = zh("apps");
  type Lang = "en" | "zh-CN";
  const groups: {
    header: string;
    headerLang: Lang;
    rows: { title: string; lang: Lang; time: string }[];
  }[] = [
    {
      header: enCommon("recentChats.groups.today"),
      headerLang: "en",
      rows: [
        { title: enChat("empty.startWithPrompt"), lang: "en", time: "09:41" },
        { title: zhApps("sections.my.newAppDraft"), lang: "zh-CN", time: "11:07" },
        { title: enApps("sections.appstore.browse"), lang: "en", time: "12:30" },
      ],
    },
    {
      header: zhCommon("recentChats.groups.yesterday"),
      headerLang: "zh-CN",
      rows: [
        { title: zhChat("empty.romeNews"), lang: "zh-CN", time: "08:15" },
        { title: enCommon("recentChats.searchDescription"), lang: "en", time: "18:02" },
        { title: zhCommon("recentChats.searchDescription"), lang: "zh-CN", time: "23:58" },
      ],
    },
    {
      header: enCommon("recentChats.groups.previous7Days"),
      headerLang: "en",
      rows: [
        { title: enApps("sections.builtin.title"), lang: "en", time: "10:00" },
        { title: zhApps("sections.appstore.title"), lang: "zh-CN", time: "17:45" },
      ],
    },
  ];
  return (
    <div className="w-72 shrink-0 rounded-12 border border-border bg-surface p-2">
      {groups.map((group) => (
        <div key={group.header}>
          <div lang={group.headerLang} className="px-2 pb-1 pt-3 text-aux text-subtle-foreground">
            {group.header}
          </div>
          {group.rows.map((row) => (
            <div
              key={row.title}
              className="flex h-8 items-center gap-2 rounded-8 px-2 text-ui text-foreground hover:bg-surface-hover"
            >
              <span lang={row.lang} className="min-w-0 flex-1 truncate">
                {row.title}
              </span>
              <span className="text-aux tabular-nums text-subtle-foreground">{row.time}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The real kit dropdown with the sidebar row menu's items, opened by clicking
 * the trigger. Deliberately not held open with a controlled `open`: a
 * permanently open floating menu only repositions on resize, so it detaches
 * from its anchor as soon as the page scrolls.
 */
function DropdownSample() {
  const enCommon = en("common");
  const zhCommon = zh("common");
  return (
    <div className="flex h-64 w-64 shrink-0 items-start rounded-12 border border-border bg-background p-4">
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm">
            {enCommon("recentChats.chatActions")}
          </Button>
        </DropdownMenuTrigger>
        {/* The content renders in a portal at document.body, outside the page
            root's lang="en" scope, so it needs its own explicit language. */}
        <DropdownMenuContent align="start" lang="en">
          <DropdownMenuLabel lang="zh-CN">{zhCommon("recentChats.chatActions")}</DropdownMenuLabel>
          <DropdownMenuItem className="text-ui">{enCommon("recentChats.rename")}</DropdownMenuItem>
          <DropdownMenuItem className="text-ui" lang="zh-CN">
            {zhCommon("recentChats.rename")}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-ui">{enCommon("recentChats.archive")}</DropdownMenuItem>
          <DropdownMenuItem className="text-ui" lang="zh-CN">
            {zhCommon("recentChats.archive")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem className="text-ui" variant="destructive">
            {enCommon("recentChats.delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** The home empty state's role stack: display greeting over the bespoke serif
 * headline over aux labels, in both languages. */
function HomeSample() {
  const columns = [
    { lang: "en" as const, t: en("chat"), name: "Ada" },
    { lang: "zh" as const, t: zh("chat"), name: "安" },
  ];
  return (
    <div className="grid flex-1 grid-cols-1 gap-6 lg:grid-cols-2">
      {columns.map((column) => (
        <div
          key={column.lang}
          lang={column.lang === "zh" ? "zh-CN" : "en"}
          className="rounded-12 border border-border bg-background p-6"
        >
          <p className="text-display text-muted-foreground">
            {column.t("empty.greeting", { name: column.name })}
          </p>
          {/* This specimen mirrors the sanctioned serif hero whose brand geometry sits outside the role roster. */}
          <h3 className="mt-1 font-serif text-[2.65rem] font-normal leading-[1.05] tracking-[-0.025em] text-foreground md:text-[3.35rem]">
            {column.t("empty.headline")}
          </h3>
          <div className="mt-8 flex items-center gap-2">
            <span className="text-aux text-foreground">{column.t("empty.pinnedChats")}</span>
            <span className="text-aux tabular-nums text-subtle-foreground">3</span>
          </div>
          <p className="mt-3 max-w-md text-ui text-foreground">
            {column.t("errors.allProvidersQuotaExhausted.description")}
          </p>
        </div>
      ))}
    </div>
  );
}

/** Right-aligned timestamp columns with and without tabular figures — mixed
 * digit widths make a proportional-figures misalignment visible immediately. */
function TimestampSample() {
  const times = ["09:41", "11:11", "23:58", "10:00", "17:45", "08:15"];
  return (
    <div className="flex gap-10 rounded-12 border border-border bg-background p-4">
      {[
        { label: "tabular-nums", numeric: "tabular-nums" },
        { label: "default figures", numeric: "" },
      ].map((variant) => (
        <div key={variant.label} className="flex flex-col items-end gap-1">
          <span className="text-aux text-muted-foreground">{variant.label}</span>
          {times.map((time) => (
            <span key={time} className={`text-aux text-foreground ${variant.numeric}`}>
              {time}
            </span>
          ))}
        </div>
      ))}
    </div>
  );
}

// "inherit" clears the override — roles don't set a family of their own, so
// inheriting means whatever the surrounding markup applies (font-sans by
// default, font-serif where the app pairs it with a role).
const FONT_CHOICES = ["inherit", "sans", "serif", "mono"] as const;
type FontChoice = (typeof FONT_CHOICES)[number];

const FONT_SLOTS = ["sans", "serif", "mono"] as const;
type FontSlot = (typeof FONT_SLOTS)[number];

/**
 * Candidate typefaces per font slot. "Default" (no stack) clears the override
 * back to the host's `--rome-font-*` token. The literal stacks below are the
 * one sanctioned exception to "never paste a font-family literal into a host
 * component": they exist to preview *alternatives* to the token, so they
 * cannot come from it. Entries with `google` are fetched from Google Fonts on
 * first selection (the app already loads its faces from there); the rest are
 * system faces.
 */
const FONT_CANDIDATES: Record<FontSlot, { label: string; stack?: string; google?: string }[]> = {
  sans: [
    { label: "Default" },
    {
      label: "Inter",
      stack: '"Inter", ui-sans-serif, system-ui, sans-serif',
      google: "Inter:wght@300;400;500;600;700",
    },
    { label: "system-ui", stack: "system-ui, sans-serif" },
    { label: "Helvetica Neue", stack: '"Helvetica Neue", Helvetica, Arial, sans-serif' },
    { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  ],
  serif: [
    { label: "Default" },
    {
      label: "Source Serif 4",
      stack: '"Source Serif 4", Georgia, serif',
      google: "Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,600;1,8..60,400",
    },
    { label: "Georgia", stack: "Georgia, serif" },
    { label: "Palatino", stack: '"Palatino Linotype", Palatino, "Book Antiqua", serif' },
    { label: "Times New Roman", stack: '"Times New Roman", Times, serif' },
  ],
  mono: [
    { label: "Default" },
    {
      label: "JetBrains Mono",
      stack: '"JetBrains Mono", ui-monospace, Menlo, monospace',
      google: "JetBrains+Mono:wght@400;500;600",
    },
    { label: "Menlo", stack: "Menlo, Monaco, ui-monospace, monospace" },
    { label: "Courier New", stack: '"Courier New", Courier, monospace' },
  ],
};

/** Injects the Google Fonts stylesheet for a candidate once, on first use. */
function ensureGoogleFont(family: string): void {
  const id = `typography-preview-font-${family}`;
  if (document.getElementById(id)) return;
  const link = document.createElement("link");
  link.id = id;
  link.rel = "stylesheet";
  link.href = `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  document.head.append(link);
}

type Override = { size?: string; leading?: string; font?: FontChoice };

/**
 * Per-role size/leading/family preview. Size and leading work because the role
 * `@theme` block is non-inline: Tailwind emits the role variables on `:root,
 * :host` and the utilities reference them with `var()`, so an inline custom
 * property on this wrapper wins by inheritance — including the
 * `--text-<role>--line-height` sub-keys, which the generated utilities also
 * read via `var()`. Family is not part of a role's utility, so it previews via
 * a scoped stylesheet the page builds (see `buildFontPreviewCss`). Preview
 * only: persisting a change goes through the normal role-definition edit.
 */
function PreviewControls({
  overrides,
  onChange,
  fontSlots,
  onFontSlotChange,
}: {
  overrides: Partial<Record<Role, Override>>;
  onChange: (next: Partial<Record<Role, Override>>) => void;
  fontSlots: Partial<Record<FontSlot, string>>;
  onFontSlotChange: (next: Partial<Record<FontSlot, string>>) => void;
}) {
  const set = (role: Role, patch: Override) =>
    onChange({ ...overrides, [role]: { ...overrides[role], ...patch } });
  const dirty =
    Object.values(overrides).some((o) => o.size || o.leading || (o.font && o.font !== "inherit")) ||
    Object.values(fontSlots).some(Boolean);
  return (
    <div className="flex flex-col gap-3 rounded-12 border border-border bg-surface p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-ui text-foreground">Preview</h2>
        <Button
          variant="outline"
          size="xs"
          disabled={!dirty}
          onClick={() => {
            onChange({});
            onFontSlotChange({});
          }}
        >
          Reset
        </Button>
      </div>
      {ROLES.map((role) => (
        <div key={role} className="flex flex-col gap-1">
          <code className="text-aux text-muted-foreground">{ROLE_CLASS[role]}</code>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              size="sm"
              inputMode="decimal"
              placeholder="px"
              aria-label={`${role} size (px)`}
              className="w-16"
              value={overrides[role]?.size ?? ""}
              onChange={(event) => set(role, { size: event.target.value })}
            />
            <Input
              type="number"
              size="sm"
              inputMode="decimal"
              step="0.05"
              placeholder="lh"
              aria-label={`${role} line height (unitless)`}
              className="w-16"
              value={overrides[role]?.leading ?? ""}
              onChange={(event) => set(role, { leading: event.target.value })}
            />
            <Select
              value={overrides[role]?.font ?? "inherit"}
              onValueChange={(value) => set(role, { font: value as FontChoice })}
            >
              <SelectTrigger
                size="sm"
                aria-label={`${role} font family`}
                className="min-w-0 flex-1"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_CHOICES.map((choice) => (
                  <SelectItem key={choice} value={choice}>
                    {choice}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      ))}
      <div className="flex flex-col gap-2 border-t border-border-subtle pt-3">
        {FONT_SLOTS.map((slot) => (
          <div key={slot} className="flex flex-col gap-1">
            <code className="text-aux text-muted-foreground">font-{slot}</code>
            <Select
              value={fontSlots[slot] ?? "Default"}
              onValueChange={(label) => {
                const candidate = FONT_CANDIDATES[slot].find((entry) => entry.label === label);
                if (candidate?.google) ensureGoogleFont(candidate.google);
                onFontSlotChange({
                  ...fontSlots,
                  [slot]: label === "Default" ? undefined : label,
                });
              }}
            >
              <SelectTrigger size="sm" aria-label={`${slot} typeface`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FONT_CANDIDATES[slot].map((candidate) => (
                  <SelectItem key={candidate.label} value={candidate.label}>
                    {candidate.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ))}
      </div>
      <p className="text-aux text-muted-foreground">
        Preview only — gone on reload. Per role: size (px), line height, font slot. Below: re-point
        a font slot at a candidate typeface. Persisting a change still goes through
        @rome-os/ui/styles.css.
      </p>
    </div>
  );
}

/**
 * Family previews can't ride the role variables (a role's utility sets no
 * font-family), so they become a scoped stylesheet: one rule per overridden
 * role, targeting that role's utility class inside the specimen wrapper and
 * pointing at the host's `--font-*` tokens — never a family literal. The
 * attribute+class selector outranks a plain utility, so the override also wins
 * over an explicit `font-serif` on a sample.
 */
function buildFontPreviewCss(overrides: Partial<Record<Role, Override>>): string {
  return ROLES.filter((role) => {
    const font = overrides[role]?.font;
    return font && font !== "inherit";
  })
    .map(
      // The backing token, not the --font-* alias: the alias is substituted at
      // :root, so a descendant inherits its resolved stack and a wrapper-level
      // --rome-font-* override could never flow through it.
      (role) =>
        `[data-typography-preview] .${ROLE_CLASS[role]} { font-family: var(--rome-font-${overrides[role]?.font}); }`,
    )
    .join("\n");
}

const MODES: { value: ThemePreference; label: string }[] = [
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
  { value: "system", label: "System" },
];

export default function TypographyPage() {
  const { preference, setPreference, theme, setTheme, themes } = useTheme();
  const [overrides, setOverrides] = useState<Partial<Record<Role, Override>>>({});
  const [fontSlots, setFontSlots] = useState<Partial<Record<FontSlot, string>>>({});
  const roleSamples = buildRoleSamples();

  const previewStyle: CSSProperties = {};
  for (const role of ROLES) {
    const override = overrides[role];
    if (override?.size) {
      (previewStyle as Record<string, string>)[`--text-${role}`] = `${override.size}px`;
    }
    if (override?.leading) {
      (previewStyle as Record<string, string>)[`--text-${role}--line-height`] = override.leading;
    }
  }
  // Typeface overrides re-point the BACKING token, --rome-font-<slot>: the
  // kit's `@theme inline` makes font-* utilities reference it directly, and
  // the host's --font-<slot> alias resolves through it, so one wrapper-level
  // declaration reaches both the utilities and the per-role slot overrides.
  for (const slot of FONT_SLOTS) {
    const label = fontSlots[slot];
    const stack = label
      ? FONT_CANDIDATES[slot].find((entry) => entry.label === label)?.stack
      : undefined;
    if (stack) (previewStyle as Record<string, string>)[`--rome-font-${slot}`] = stack;
  }
  // Most page text inherits its family from <body> (outside this wrapper), so
  // a sans re-point must re-declare the family here for descendants to pick it
  // up — via the backing token (see buildFontPreviewCss on why not the alias);
  // serif/mono usages carry their own font-* utility and re-resolve at the
  // element.
  if (fontSlots.sans) previewStyle.fontFamily = "var(--rome-font-sans)";
  const fontPreviewCss = buildFontPreviewCss(overrides);

  return (
    // lang="en" severs the page from <html lang>, which follows the guardian's
    // app language: every localized string below carries an explicit lang (the
    // Chinese ones override with zh-CN), so per-script font fallback and
    // shaping are fixed regardless of the active app language.
    <div lang="en" className="min-h-screen bg-background">
      <header className="sticky top-0 z-40 border-b border-border bg-surface/95 px-6 py-4 backdrop-blur">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-title text-foreground">Typography specimen</h1>
            <p className="mt-1 text-aux text-muted-foreground">
              Dev-only. Every number below is read from the live role definitions via
              getComputedStyle — edit a role in @rome-os/ui/styles.css and this page follows.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {themes.length > 1 ? (
              <SegmentedControl
                aria-label="Theme"
                size="sm"
                options={themes.map((entry) => ({ value: entry.id, label: entry.label }))}
                value={theme || DEFAULT_THEME_NAME}
                onValueChange={setTheme}
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
      </header>

      {fontPreviewCss ? <style>{fontPreviewCss}</style> : null}
      {/* The controls live in a pinned sidebar so a tweak stays reachable
          while scrolling any specimen; below lg it degrades to a block above
          the content. The preview wrapper spans both columns, so the controls
          themselves render under the overrides too — live feedback, not a
          bug. */}
      <div
        data-typography-preview
        className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-8 lg:flex-row"
        style={previewStyle}
      >
        <aside className="w-full shrink-0 lg:sticky lg:top-24 lg:max-h-[calc(100dvh-7.5rem)] lg:w-72 lg:self-start lg:overflow-y-auto">
          <PreviewControls
            overrides={overrides}
            onChange={setOverrides}
            fontSlots={fontSlots}
            onFontSlotChange={setFontSlots}
          />
        </aside>

        <div className="flex min-w-0 flex-1 flex-col gap-12">
          <Section
            title="Live spec"
            note="Generated from computed values of the sample cells — no role numbers are written in this page."
          >
            <SpecTable />
          </Section>

          <Section title="Roles" note="Sample copy comes from the en / zh-CN locale files.">
            <div className="flex flex-col gap-6">
              {roleSamples.map((def) => (
                <RoleSample key={def.role} def={def} />
              ))}
            </div>
          </Section>

          <Section
            title="In context"
            note="Isolated rows show a role's spec; these show whether the set holds together — group headers against rows against timestamps, alternating English and Chinese."
          >
            <div className="flex flex-wrap items-start gap-6">
              <SidebarSample />
              <DropdownSample />
              <TimestampSample />
            </div>
            <HomeSample />
          </Section>
        </div>
      </div>
    </div>
  );
}
