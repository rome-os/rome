import { useEffect, useMemo, useRef, useState } from "react";
import { navigateRome, type RomeAppBootstrap } from "@rome-os/app-web-sdk";
import { ArrowUp, ChevronDown, FileText, Link2, PenLine, Plus, Search, Zap } from "lucide-react";
import "./styles.css";
import { isImeCompositionEvent, shouldSubmitOnEnter } from "@rome-os/ui/keyboard-submit";

interface SkillSummary {
  name: string;
  description: string;
  tools: string[];
  ownerType: "core" | "app";
  ownerId: string;
}

const USER_SKILLS_APP_ID = "user-skills";

/** Fixed name-column width so descriptions align across rows (mockup-style). */
const NAME_COL = "13rem";

interface SkillGroup {
  ownerId: string;
  label: string;
  skills: SkillSummary[];
}

function groupSkills(skills: SkillSummary[]): SkillGroup[] {
  const byOwner = new Map<string, SkillSummary[]>();
  for (const skill of skills) {
    const list = byOwner.get(skill.ownerId) ?? [];
    list.push(skill);
    byOwner.set(skill.ownerId, list);
  }
  const groups: SkillGroup[] = Array.from(byOwner.entries()).map(([ownerId, list]) => ({
    ownerId,
    label: ownerId === USER_SKILLS_APP_ID ? "Your skills" : ownerId,
    skills: list,
  }));
  // "Your skills" first, then the rest alphabetically by owner.
  groups.sort((a, b) => {
    if (a.ownerId === USER_SKILLS_APP_ID) return -1;
    if (b.ownerId === USER_SKILLS_APP_ID) return 1;
    return a.ownerId.localeCompare(b.ownerId);
  });
  return groups;
}

function filterSkills(skills: SkillSummary[], query: string): SkillSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return skills;
  return skills.filter(
    (skill) => skill.name.toLowerCase().includes(q) || skill.description.toLowerCase().includes(q),
  );
}

type ImportKind = "link" | "skillmd" | "describe";

/**
 * Mirror of the import-skill skill's own step-1 classification, so the
 * add bar can tell the guardian what the skill is about to do with the input
 * before they commit. Heuristic only; the skill re-classifies server-side.
 */
function detectImportKind(text: string): ImportKind | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\/\S+$/i.test(t)) return "link";
  if (/^---\s*\n/.test(t) || (/^name:\s*\S+/m.test(t) && /^description:/m.test(t))) {
    return "skillmd";
  }
  return "describe";
}

const IMPORT_KINDS: Record<
  ImportKind,
  { icon: typeof Link2; badge: string; hint: string; submitLabel: string }
> = {
  link: {
    icon: Link2,
    badge: "link",
    hint: "Looks like a link. The skill fetches it, previews the result, and installs only after you confirm.",
    submitLabel: "Import from link",
  },
  skillmd: {
    icon: FileText,
    badge: "SKILL.md",
    hint: "Looks like a SKILL.md. The skill validates it and shows the final file before installing.",
    submitLabel: "Review and install",
  },
  describe: {
    icon: PenLine,
    badge: "draft",
    hint: "The skill drafts this with you and installs it once you approve.",
    submitLabel: "Draft this skill",
  },
};

/** Single-row textarea that grows with its content, capped at ~6 lines. */
function AutoGrowTextarea({
  value,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value]);
  return <textarea ref={ref} rows={1} value={value} {...props} />;
}

/**
 * Always-visible add bar. Submitting opens a new chat with the `import-skill`
 * skill riding as a structured chip and the input as draft text — un-sent, so
 * the guardian reviews and commits the message themselves. The
 * skill fetches or drafts the SKILL.md, previews it, and installs into the
 * user-skills carrier only after the guardian confirms.
 */
function AddSkillBar() {
  const [input, setInput] = useState("");

  const kind = detectImportKind(input);
  const detected = kind ? IMPORT_KINDS[kind] : null;

  function submit() {
    const draft = input.trim();
    if (!draft) return;
    // Mirror SkillRow: the skill name rides as a field (never parsed from the
    // text), the input lands as draft so the guardian sends it themselves.
    navigateRome({ path: "chat/new", draft, skill: "import-skill" });
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-end gap-2 rounded-12 border border-border bg-surface px-3 py-2 focus-within:border-primary/60">
        <Plus className="mb-2 h-4 w-4 shrink-0 text-subtle-foreground" aria-hidden />
        <AutoGrowTextarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (shouldSubmitOnEnter(e)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a skill: paste a link or SKILL.md, or describe the one you want"
          className="max-h-40 min-w-0 flex-1 resize-none overflow-y-auto bg-transparent py-1.5 text-sm text-foreground placeholder:text-subtle-foreground focus:outline-none"
        />
        <span
          className={
            "mb-1.5 shrink-0 rounded-full border px-2 py-0.5 font-mono text-badge " +
            (detected ? "border-primary/40 text-primary" : "border-border text-subtle-foreground")
          }
        >
          {detected?.badge ?? "auto"}
        </span>
        <button
          type="button"
          onClick={submit}
          disabled={!input.trim()}
          aria-label={detected?.submitLabel ?? "Add skill"}
          title={detected ? `${detected.submitLabel} (↵)` : "Add a skill"}
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
      {detected && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-muted-foreground">
          <detected.icon className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden />
          {detected.hint}
        </p>
      )}
    </div>
  );
}

function SkillRow({
  skill,
  expanded,
  onToggle,
}: {
  skill: SkillSummary;
  expanded: boolean;
  onToggle: () => void;
}) {
  const [task, setTask] = useState("");

  function startChat() {
    const trimmed = task.trim();
    // The skill rides as a structured chip and the task as plain draft text —
    // both land in the composer un-sent, so the guardian reviews and commits
    // the message themselves. The name is sent as a field, never
    // parsed out of the text, so any catalog name works.
    navigateRome({ path: "chat/new", draft: trimmed || undefined, skill: skill.name });
  }

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="group grid w-full items-baseline gap-x-3 py-2.5 text-left"
        style={{ gridTemplateColumns: `${NAME_COL} minmax(0,1fr) auto` }}
      >
        <span
          className={
            "truncate font-mono text-sm font-medium transition-colors " +
            (expanded ? "text-primary" : "text-foreground group-hover:text-primary")
          }
        >
          /{skill.name}
        </span>
        <span className="truncate text-sm text-muted-foreground">
          {expanded ? "" : skill.description}
        </span>
        <ChevronDown
          className={
            "h-4 w-4 self-center text-subtle-foreground transition-transform motion-reduce:transition-none " +
            (expanded ? "rotate-180" : "")
          }
          aria-hidden
        />
      </button>
      {expanded && (
        <div
          className="grid gap-x-3 pb-4"
          style={{ gridTemplateColumns: `${NAME_COL} minmax(0,1fr)` }}
        >
          <div />
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-relaxed text-muted-foreground">{skill.description}</p>
            {skill.tools.length > 0 && (
              <p className="font-mono text-xs text-subtle-foreground">
                tools · {skill.tools.join(" · ")}
              </p>
            )}
            <div className="flex items-end gap-2">
              <AutoGrowTextarea
                value={task}
                onChange={(e) => setTask(e.target.value)}
                onKeyDown={(e) => {
                  if (isImeCompositionEvent(e)) return;
                  if (shouldSubmitOnEnter(e)) {
                    e.preventDefault();
                    startChat();
                  } else if (e.key === "Escape") {
                    e.stopPropagation();
                    onToggle();
                  }
                }}
                placeholder="What do you want to do with this skill? (optional)"
                autoFocus
                className="max-h-40 min-w-0 flex-1 resize-none overflow-y-auto rounded-8 border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-subtle-foreground focus:border-primary/60 focus:outline-none"
              />
              <button
                type="button"
                onClick={startChat}
                aria-label={`Start a chat with /${skill.name}`}
                title="Start chat (↵)"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground hover:opacity-90"
              >
                <ArrowUp className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SkeletonRow() {
  return (
    <div
      className="grid items-center gap-x-3 py-3"
      style={{ gridTemplateColumns: `${NAME_COL} minmax(0,1fr) auto` }}
    >
      <div className="h-3.5 w-32 animate-pulse rounded-4 bg-surface-muted" />
      <div className="h-3.5 w-full max-w-md animate-pulse rounded-4 bg-surface-muted" />
      <div className="h-4 w-4" />
    </div>
  );
}

export default function SkillsApp(_props: { bootstrap: RomeAppBootstrap }) {
  const [skills, setSkills] = useState<SkillSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  // Name of the skill whose expanded detail/composer panel is open.
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills", { credentials: "include" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`Skill list request failed with ${res.status}`);
        const data = (await res.json()) as { skills?: SkillSummary[] };
        if (!cancelled) setSkills(data.skills ?? []);
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const groups = useMemo(() => groupSkills(filterSkills(skills ?? [], query)), [skills, query]);

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-6 p-6">
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">Skills</h1>
          {skills !== null && (
            <span className="text-sm text-muted-foreground">{skills.length} installed</span>
          )}
        </div>
        <p className="text-sm text-muted-foreground">
          Type <span className="font-mono text-foreground">/name</span> in any chat to call one
        </p>
      </header>

      <AddSkillBar />

      {error ? (
        <div className="rounded-8 border border-destructive-border bg-destructive-bg px-3 py-2 text-sm text-destructive-fg">
          {error}
        </div>
      ) : skills === null ? (
        <div className="divide-y divide-border" aria-label="Loading skills">
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
          <SkeletonRow />
        </div>
      ) : skills.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-16 text-center">
          <Zap className="h-8 w-8 text-subtle-foreground" aria-hidden />
          <p className="text-sm font-medium text-foreground">No skills installed yet</p>
          <p className="max-w-sm text-sm text-muted-foreground">
            Paste a link or a SKILL.md in the bar above, or describe the skill you want and let Rome
            write it.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5 overflow-y-auto pb-6">
          <div className="flex items-center justify-between gap-4 border-b border-border pb-2">
            <h2 className="text-sm font-medium text-muted-foreground">Installed</h2>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Filter…"
                aria-label="Filter skills"
                className="h-8 w-48 rounded-8 border border-border bg-surface pl-8 pr-2 text-sm text-foreground placeholder:text-subtle-foreground focus:border-primary/60 focus:outline-none"
              />
            </div>
          </div>

          {groups.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No skills match “{query.trim()}”.{" "}
              <button
                type="button"
                onClick={() => setQuery("")}
                className="text-foreground underline underline-offset-2 hover:text-primary"
              >
                Clear filter
              </button>
            </p>
          ) : (
            groups.map((group) => (
              <section key={group.ownerId}>
                <h3 className="flex items-baseline gap-1.5 border-b border-border pb-1.5 text-xs font-medium text-muted-foreground">
                  {group.label}
                  <span className="font-normal text-subtle-foreground">{group.skills.length}</span>
                </h3>
                <div className="divide-y divide-border-subtle">
                  {group.skills.map((skill) => (
                    <SkillRow
                      key={skill.name}
                      skill={skill}
                      expanded={selected === skill.name}
                      onToggle={() =>
                        setSelected((prev) => (prev === skill.name ? null : skill.name))
                      }
                    />
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      )}
    </div>
  );
}
