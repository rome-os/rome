import { useEffect, useRef, useState, type ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useTheme } from "@/hooks/use-theme";
import type { ResolvedTheme } from "@/lib/theme";

// Dev-only design-system gallery. The verification surface for the semantic
// token layer: specimens follow the active mode or compare light and dark
// (comparison columns force `.light`/`.dark`, independent of the global mode),
// and each `ui/` primitive is rendered in every variant. The shadow-DOM parity
// panel proves an app sandbox inherits the host theme across the shadow boundary
// with nothing injected.

type TokenGroup = { name: string; tokens: string[] };

const TOKEN_GROUPS: TokenGroup[] = [
  { name: "Base", tokens: ["background", "foreground"] },
  {
    name: "Surface",
    tokens: [
      "surface",
      "surface-foreground",
      "surface-muted",
      "surface-muted-foreground",
      "surface-elevated",
      "surface-hover",
    ],
  },
  { name: "Text", tokens: ["muted-foreground", "subtle-foreground"] },
  { name: "Border & Input", tokens: ["border", "border-strong", "border-subtle", "ring", "input"] },
  { name: "Primary", tokens: ["primary", "primary-foreground", "primary-hover"] },
  { name: "Brand (our violet)", tokens: ["brand", "brand-fg"] },
  {
    name: "shadcn-named (contract)",
    tokens: [
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
      "secondary",
      "secondary-foreground",
      "muted",
      "accent",
      "accent-foreground",
    ],
  },
  {
    name: "Destructive",
    tokens: [
      "destructive",
      "destructive-bg",
      "destructive-fg",
      "destructive-border",
      "destructive-hover-bg",
    ],
  },
  {
    name: "Success",
    tokens: ["success", "success-bg", "success-fg", "success-border"],
  },
  {
    name: "Warning",
    tokens: ["warning", "warning-bg", "warning-fg", "warning-border", "warning-hover-bg"],
  },
  { name: "Info", tokens: ["info", "info-bg", "info-fg", "info-border"] },
];

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
const BUTTON_VARIANTS = [
  "default",
  "outline",
  "secondary",
  "ghost",
  "destructive",
  "link",
] as const;
const BUTTON_SIZES = ["xs", "sm", "default"] as const;

function Swatch({ token }: { token: string }) {
  const { theme, resolved } = useTheme();
  const ref = useRef<HTMLDivElement>(null);
  const [value, setValue] = useState("");
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (ref.current) setValue(getComputedStyle(ref.current).backgroundColor);
    });
    return () => cancelAnimationFrame(frame);
  }, [theme, resolved]);
  return (
    <div className="flex flex-col gap-1">
      <div
        ref={ref}
        className="h-12 w-full rounded-8 border border-border-subtle"
        style={{ backgroundColor: `var(--${token})` }}
      />
      <code className="text-aux text-foreground">--{token}</code>
      <code className="truncate text-aux text-muted-foreground" title={value}>
        {value || "—"}
      </code>
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-ui text-foreground">{title}</h3>
      {children}
    </section>
  );
}

// The full catalog, rendered once per theme column.
function Showcase() {
  return (
    <div className="flex flex-col gap-8 bg-background p-6 text-foreground">
      <div className="flex flex-col gap-6">
        <h2 className="text-aux text-muted-foreground">Semantic tokens</h2>
        {TOKEN_GROUPS.map((group) => (
          <Section key={group.name} title={group.name}>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4">
              {group.tokens.map((token) => (
                <Swatch key={token} token={token} />
              ))}
            </div>
          </Section>
        ))}
      </div>

      <div className="flex flex-col gap-6">
        <h2 className="text-aux text-muted-foreground">Components</h2>

        <Section title="Badge — pill">
          <div className="flex flex-wrap gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant}>
                {variant}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Badge — square">
          <div className="flex flex-wrap gap-2">
            {BADGE_VARIANTS.map((variant) => (
              <Badge key={variant} variant={variant} shape="square">
                {variant}
              </Badge>
            ))}
          </div>
        </Section>

        <Section title="Button">
          <div className="flex flex-col gap-2">
            {BUTTON_SIZES.map((size) => (
              <div key={size} className="flex flex-wrap items-center gap-2">
                {BUTTON_VARIANTS.map((variant) => (
                  <Button key={variant} variant={variant} size={size}>
                    {variant}
                  </Button>
                ))}
              </div>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
}

// Mounts a real shadow root whose content references host tokens
// (var(--card)/--accent/--brand/…) and ships no values of its own — exactly how
// a third-party app bundle renders. No theme is injected: Rome's semantic tokens
// are inherited custom properties that pierce the shadow boundary, so what
// renders is proof the host theme reaches the shadow tree on its own. The fork is
// driven from an *ancestor* wrapper (.light / .dark) — inheritance carries the
// per-mode values across the boundary — which is why the two panels differ
// without any per-mode CSS inside the shadow.
function ShadowPanel({ mode }: { mode: "light" | "dark" }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const root = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    root.replaceChildren();

    const style = document.createElement("style");
    style.textContent = `
      .panel { font-family: ui-sans-serif, system-ui, sans-serif; padding: 16px; background: var(--background); color: var(--foreground); }
      .card { background: var(--card); color: var(--card-foreground); border: 1px solid var(--border); border-radius: var(--rome-radius-12); padding: 12px; }
      .title { font-weight: 600; font-size: 13px; }
      .sub { color: var(--muted-foreground); font-size: 12px; margin-top: 2px; }
      .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
      .chip { padding: 4px 10px; border-radius: var(--rome-radius-full); font-size: 12px; }
      .accent { background: var(--accent); color: var(--accent-foreground); }
      .brand { background: var(--brand); color: var(--brand-fg); }
      .success { background: var(--success-bg); color: var(--success-fg); border: 1px solid var(--success-border); }
      .warning { background: var(--warning-bg); color: var(--warning-fg); border: 1px solid var(--warning-border); }
    `;
    root.append(style);

    const body = document.createElement("body");
    body.innerHTML = `
      <div class="panel">
        <div class="card">
          <div class="title">Sample app — ${mode}</div>
          <div class="sub">shadow root · host tokens only · no baked values</div>
          <div class="row">
            <span class="chip accent">accent (neutral hover)</span>
            <span class="chip brand">brand (violet)</span>
            <span class="chip success">success</span>
            <span class="chip warning">warning</span>
          </div>
        </div>
      </div>`;
    root.append(body);
  }, [mode]);
  return <div ref={ref} />;
}

function ShadowParityDemo({ modes }: { modes: ResolvedTheme[] }) {
  const { theme } = useTheme();
  return (
    <div
      className={`mt-4 grid grid-cols-1 overflow-hidden rounded-12 border border-border-strong ${modes.length === 2 ? "sm:grid-cols-2" : ""}`}
    >
      {modes.map((mode) => (
        <div key={mode} className={mode} data-theme={theme}>
          <ShadowPanel mode={mode} />
        </div>
      ))}
    </div>
  );
}

export default function StyleGuidePage({ compareModes = true }: { compareModes?: boolean }) {
  const { theme, resolved } = useTheme();
  const modes: ResolvedTheme[] = compareModes ? ["light", "dark"] : [resolved];
  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-surface px-6 py-4">
        <h1 className="text-title text-foreground">Design System — Styleguide</h1>
        <p className="text-body text-muted-foreground">
          {compareModes
            ? "Light and dark specimens are shown together for comparison."
            : `Showing ${resolved} mode. Specimens follow the active color mode.`}
        </p>
      </header>

      <div className={`grid grid-cols-1 ${compareModes ? "lg:grid-cols-2" : ""}`}>
        {modes.map((mode) => (
          <div
            key={mode}
            className={`${mode} border-border ${compareModes ? "first:lg:border-r" : ""}`}
            data-theme={theme}
          >
            <Showcase />
          </div>
        ))}
      </div>

      <div className="border-t border-border bg-surface px-6 py-8">
        <h2 className="text-ui text-foreground">App shadow-DOM parity</h2>
        <p className="mt-1 max-w-2xl text-body text-muted-foreground">
          A real shadow root with <em>nothing injected</em>. The markup references host tokens only
          — it ships no baked values — yet renders correctly because Rome's semantic tokens are
          inherited custom properties that pierce the shadow boundary:{" "}
          <code className="text-aux">accent</code> renders neutral (not violet),{" "}
          <code className="text-aux">brand</code> is the violet, and the per-mode fork is driven
          entirely from the <code className="text-aux">.light</code>/
          <code className="text-aux">.dark</code> ancestor wrapper.
        </p>
        <ShadowParityDemo modes={modes} />
      </div>
    </div>
  );
}
