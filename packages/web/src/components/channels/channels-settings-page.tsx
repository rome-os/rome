import {
  Children,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TFunction } from "i18next";
import { Search } from "lucide-react";
import type {
  ConversationSettingField,
  ConversationSettings,
  ConversationSettingsListItem,
  ConversationSettingsSnapshot,
  PartialConversationSettings,
  ProviderSessionResetPolicy,
} from "@rome/api-types/conversation-settings";
import { ConnectionBrandBadge } from "@/components/brand-icons/connection-badges";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { FieldGroupLabel, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Spinner } from "@rome-os/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { artifactLocalName, artifactOwnerId } from "@/lib/artifact-name";
import { serviceLabel } from "@/lib/connection-cards";
import { fetchConnections, type ApiConnection } from "@/lib/connections-api";

interface PageResponse {
  items: ConversationSettingsListItem[];
  nextCursor?: string;
}

/** Coalesces a burst of edits — typing in the inactivity field — into one PATCH. */
const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * A Select item cannot carry an empty value, so "no filter" needs a sentinel.
 * It never escapes this module: both filters map it back to "" before the
 * choice reaches the URL or the request, so an unfiltered list still sends no
 * `connectionId` / `availability` param at all.
 */
const ALL_CONNECTIONS = "all";
const ANY_STATUS = "any";

interface AgentPage {
  agents: Array<{ name: string }>;
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export function ChannelsSettingsPage() {
  const { t } = useTranslation("settings");
  const [params, setParams] = useSearchParams();
  const connectionId = params.get("connectionId") ?? "";
  const [query, setQuery] = useState("");
  const [availability, setAvailability] = useState("");
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [items, setItems] = useState<ConversationSettingsListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      setError("");
      try {
        const search = new URLSearchParams({ limit: "100" });
        if (connectionId) search.set("connectionId", connectionId);
        if (query.trim()) search.set("query", query.trim());
        if (availability) search.set("availability", availability);
        if (cursor) search.set("cursor", cursor);
        const [page, connectionList, agentPage] = await Promise.all([
          api<PageResponse>(`/api/conversation-settings?${search}`),
          fetchConnections(),
          api<AgentPage>("/api/agents"),
        ]);
        setItems((current) => (append ? [...current, ...page.items] : page.items));
        setNextCursor(page.nextCursor);
        setConnections(connectionList);
        setAgentNames(agentPage.agents.map((agent) => agent.name));
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [availability, connectionId, query],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(timer);
  }, [load]);

  // Offerable placeholders (a registered service that was never connected) have
  // no ledger id, so they can own no conversation and cannot be filtered by.
  const talkConnections = useMemo(
    () =>
      connections.flatMap((connection) =>
        connection.id !== null && connection.capabilities.talk?.state !== "unsupported"
          ? [{ id: connection.id, label: connection.label }]
          : [],
      ),
    [connections],
  );

  // Stable identity: every card takes this as a dependency, so an inline
  // function here would change on each render and churn their save closures.
  const handleSaved = useCallback((snapshot: ConversationSettingsSnapshot) => {
    setItems((current) =>
      current.map((candidate) =>
        candidate.snapshot.conversation.ref.connectionId ===
          snapshot.conversation.ref.connectionId &&
        candidate.snapshot.conversation.ref.conversationId ===
          snapshot.conversation.ref.conversationId
          ? { ...candidate, snapshot, source: hasOverrides(snapshot) ? "configured" : "known" }
          : candidate,
      ),
    );
  }, []);

  function chooseConnection(next: string) {
    const updated = new URLSearchParams(params);
    if (next) updated.set("connectionId", next);
    else updated.delete("connectionId");
    setParams(updated, { replace: true });
  }

  return (
    <section className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_180px_150px]">
        <label className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("channels.conversationSettings.searchPlaceholder")}
            className="pl-9"
          />
        </label>
        <Select
          value={connectionId || ALL_CONNECTIONS}
          onValueChange={(next) => chooseConnection(next === ALL_CONNECTIONS ? "" : next)}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("channels.conversationSettings.connectionFilterAria")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CONNECTIONS}>
              {t("channels.conversationSettings.allConnections")}
            </SelectItem>
            {talkConnections.map((connection) => (
              <SelectItem key={connection.id} value={connection.id}>
                {connection.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={availability || ANY_STATUS}
          onValueChange={(next) => setAvailability(next === ANY_STATUS ? "" : next)}
        >
          <SelectTrigger
            className="w-full"
            aria-label={t("channels.conversationSettings.statusFilterAria")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY_STATUS}>
              {t("channels.conversationSettings.anyStatus")}
            </SelectItem>
            <SelectItem value="online">
              {t("channels.conversationSettings.status.online")}
            </SelectItem>
            <SelectItem value="offline">
              {t("channels.conversationSettings.status.offline")}
            </SelectItem>
            <SelectItem value="not-connected">
              {t("channels.conversationSettings.status.notConnected")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      {loading ? (
        <EmptyState className="rounded-12 border border-dashed border-border">
          <EmptyStateIcon>
            <Spinner label={t("channels.conversationSettings.loading")} />
          </EmptyStateIcon>
          <EmptyStateTitle>{t("channels.conversationSettings.loading")}</EmptyStateTitle>
        </EmptyState>
      ) : error ? (
        <Alert variant="destructive" className="flex flex-wrap items-center justify-between gap-3">
          <AlertDescription className="text-ui">{error}</AlertDescription>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            {t("channels.conversationSettings.retry")}
          </Button>
        </Alert>
      ) : items.length === 0 ? (
        <EmptyState className="rounded-12 border border-dashed border-border">
          <EmptyStateTitle>{t("channels.conversationSettings.emptyTitle")}</EmptyStateTitle>
          <EmptyStateDescription>
            {t("channels.conversationSettings.emptyDescription")}
          </EmptyStateDescription>
        </EmptyState>
      ) : (
        <>
          <div className="space-y-4">
            {items.map((item) => (
              <ConversationRow
                key={`${item.snapshot.conversation.ref.connectionId}:${item.snapshot.conversation.ref.conversationId}`}
                item={item}
                agentNames={agentNames}
                onSaved={handleSaved}
              />
            ))}
          </div>
          {nextCursor && (
            <div className="flex justify-center">
              <Button
                variant="outline"
                disabled={loading}
                onClick={() => void load(nextCursor, true)}
              >
                {t("channels.conversationSettings.loadMore")}
              </Button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

function ConversationRow({
  item,
  agentNames,
  onSaved,
}: {
  item: ConversationSettingsListItem;
  agentNames: string[];
  onSaved: (snapshot: ConversationSettingsSnapshot) => void;
}) {
  const { t } = useTranslation("settings");
  const agentFieldId = useId();
  const enabledFieldId = useId();
  const headingId = useId();
  const { snapshot } = item;
  const conversation = snapshot.conversation;
  const supported = new Set(snapshot.supportedFields);
  const overrideCount = snapshot.supportedFields.filter(
    (field) => settingSource(snapshot, field) === "overridden",
  ).length;
  const [draft, setDraft] = useState<ConversationSettings>(() =>
    structuredClone(snapshot.effective),
  );
  const [saving, setSaving] = useState(false);
  const routingOptions = Array.from(
    new Set(
      ["main", ...agentNames, ...(draft.routing.agentName ? [draft.routing.agentName] : [])].map(
        (name) => (name === "core:main" ? "main" : name),
      ),
    ),
  );

  /**
   * The draft mirrored into a ref. The debounce timer and the unmount cleanup
   * both read the latest edit after the render that queued it, where the state
   * value would still be the previous one.
   */
  const draftRef = useRef(draft);
  const applyDraft = useCallback((next: ConversationSettings) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /**
   * Which fields have been touched since the last PATCH. Only the field names —
   * the values are read off the draft at flush time, so a field edited several
   * times in one burst contributes exactly one value: its last.
   */
  const dirty = useRef(new Set<ConversationSettingField>());
  const flushTimer = useRef<number>(undefined);
  // Serializes PATCHes: two edits in quick succession must not race, or the
  // later response can be overtaken by the earlier one and show a stale value.
  const inFlight = useRef<Promise<unknown>>(Promise.resolve());
  // The request itself still goes out after unmount — that is the point of the
  // unmount flush — but its response has no live tree to write back into.
  const mounted = useRef(true);
  /**
   * What the server is expected to hold once every batch already sent has
   * landed — the last confirmed snapshot plus the values of any in-flight
   * PATCH. No-op pruning diffs against *this*, not against the snapshot: a
   * batch in flight has not come back yet, so the snapshot still shows the
   * pre-edit value, and pruning against it would drop a genuine change back to
   * that value as if it were a no-op.
   */
  const projected = useRef<ConversationSettings>(structuredClone(snapshot.effective));
  /** Batches enqueued but not yet settled; only the last one may resync `projected`. */
  const queued = useRef(0);

  const flush = useCallback(() => {
    const fields = dirty.current;
    dirty.current = new Set();
    // A field edited and put back before the debounce elapsed is not an edit.
    // Sending it would make the round-trip a durable override, which the UI has
    // no way to undo — so diff against projected state and drop no-ops.
    const sent: Array<[ConversationSettingField, unknown, unknown]> = [];
    const set: PartialConversationSettings = {};
    const ahead = structuredClone(projected.current);
    for (const field of fields) {
      const value = settingValue(draftRef.current, field);
      const previous = settingValue(projected.current, field);
      if (settingValuesEqual(value, previous)) continue;
      setPartialSettingValue(set, field, value);
      setSettingValue(ahead, field, value);
      sent.push([field, value, previous]);
    }
    if (sent.length === 0) return inFlight.current;
    projected.current = ahead;
    queued.current += 1;

    setSaving(true);
    inFlight.current = inFlight.current
      .then(() =>
        api<ConversationSettingsSnapshot>("/api/conversation-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: conversation.ref, set, clear: [] }),
        }),
      )
      .then((next) => {
        queued.current -= 1;
        // Only the last outstanding batch may adopt the response as the whole
        // projected state — an earlier one's response predates batches already
        // enqueued behind it.
        if (queued.current === 0) projected.current = structuredClone(next.effective);
        if (!mounted.current) return;
        onSaved(next);
        // An edit queued while this was in flight leaves the draft ahead of the
        // server on purpose; adopting the response would revert it mid-typing.
        if (dirty.current.size === 0) applyDraft(structuredClone(next.effective));
      })
      .catch((err) => {
        queued.current -= 1;
        // Roll back only the fields this request carried, and only those the
        // user has not touched since. A blanket revert would also wipe an
        // unrelated edit queued while this PATCH was in flight — and because
        // that edit would then match the reverted state, the next flush would
        // diff it away, losing it from the UI and the server both.
        const rolledBack = structuredClone(projected.current);
        const restored = structuredClone(draftRef.current);
        for (const [field, , previous] of sent) {
          if (dirty.current.has(field)) continue;
          setSettingValue(rolledBack, field, previous);
          setSettingValue(restored, field, previous);
        }
        projected.current = rolledBack;
        if (mounted.current) applyDraft(restored);
        toast.error(err instanceof Error ? err.message : String(err), {
          action: {
            label: t("channels.conversationSettings.retry"),
            // Re-apply what was rejected rather than making the user redo it.
            onClick: () => {
              const next = structuredClone(draftRef.current);
              for (const [field, value] of sent) {
                setSettingValue(next, field, value);
                dirty.current.add(field);
              }
              applyDraft(next);
              flushRef.current();
            },
          },
        });
      })
      .finally(() => {
        if (mounted.current) setSaving(false);
      });
    return inFlight.current;
  }, [applyDraft, conversation.ref, onSaved, t]);

  // Lets the retry action and the unmount cleanup reach the current flush
  // without taking it as a dependency — see the unmount effect below.
  const flushRef = useRef(flush);
  useEffect(() => {
    flushRef.current = flush;
  }, [flush]);

  // A queued edit means the draft is ahead of the server on purpose; letting a
  // refreshed snapshot overwrite it would revert what the user just typed.
  useEffect(() => {
    if (dirty.current.size > 0 || queued.current > 0) return;
    projected.current = structuredClone(snapshot.effective);
    applyDraft(structuredClone(snapshot.effective));
  }, [snapshot, applyDraft]);

  // Leaving the page mid-debounce must not silently discard the edit. Empty
  // deps on purpose: keyed on `flush` this would re-run on every parent render
  // and flush queued edits ahead of their debounce window.
  useEffect(() => {
    return () => {
      window.clearTimeout(flushTimer.current);
      flushRef.current();
      mounted.current = false;
    };
  }, []);

  /**
   * Every control writes through here: the draft updates immediately so the UI
   * stays responsive, and the change is coalesced into one PATCH per burst.
   */
  function change(field: ConversationSettingField, value: unknown) {
    const next = structuredClone(draftRef.current);
    setSettingValue(next, field, value);
    applyDraft(next);
    dirty.current.add(field);
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
  }

  return (
    <article
      aria-labelledby={headingId}
      className="overflow-hidden rounded-12 border border-border bg-surface px-4"
    >
      <header className="-mx-4 flex items-start gap-3 border-b border-border px-4 py-4">
        <ConnectionBrandBadge connection={conversation.service} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            {/* The container reads as the place the conversation lives, so it
                prefixes the name rather than sitting in the meta line — a bare
                provider-supplied name ("can you see active chats?") gives no
                clue on its own that it names a conversation. */}
            <h3 id={headingId} className="truncate text-ui text-foreground">
              {conversation.containerName && (
                <span className="text-muted-foreground">{conversation.containerName} / </span>
              )}
              {conversation.displayName}
            </h3>
            <Badge variant={item.availability === "online" ? "success" : "muted"}>
              {t(
                `channels.conversationSettings.status.${
                  item.availability === "not-connected" ? "notConnected" : item.availability
                }`,
              )}
            </Badge>
            <Badge variant="muted">
              {overrideCount > 0
                ? t("channels.conversationSettings.overrideCount", { count: overrideCount })
                : t("channels.conversationSettings.providerDefaults")}
            </Badge>
          </div>
          {/* Visually the kind is enough — the brand badge says which service
              this is. That badge is aria-hidden though, so in a mixed-provider
              list the service would otherwise be absent from the a11y tree. */}
          <p className="mt-1 truncate text-aux text-muted-foreground">
            {t(`channels.conversationSettings.kinds.${conversation.kind}`)}
            <span className="sr-only">{` · ${serviceLabel(conversation.service)}`}</span>
          </p>
        </div>
        {saving && (
          <span className="shrink-0 text-aux text-muted-foreground">
            {t("channels.conversationSettings.saving")}
          </span>
        )}
      </header>

      <SettingSection>
        {supported.has("enabled") && (
          <SettingRow
            field="enabled"
            overridden={settingSource(snapshot, "enabled") === "overridden"}
            controlId={enabledFieldId}
          >
            <Switch
              id={enabledFieldId}
              checked={draft.enabled}
              onCheckedChange={(enabled) => change("enabled", enabled)}
            />
          </SettingRow>
        )}
      </SettingSection>

      <SettingSection title={t("channels.conversationSettings.sections.activation")}>
        {supported.has("activation.mode") && (
          <SelectSettingRow
            field="respond"
            overridden={settingSource(snapshot, "activation.mode") === "overridden"}
            value={draft.activation.mode}
            options={settingOptions(t, ["mention", "all"])}
            onChange={(mode) => change("activation.mode", mode)}
          />
        )}
        {supported.has("activation.botMessages") && (
          <SelectSettingRow
            field="botMessages"
            overridden={settingSource(snapshot, "activation.botMessages") === "overridden"}
            value={draft.activation.botMessages}
            options={settingOptions(t, ["ignore", "mentions", "all"])}
            onChange={(botMessages) => change("activation.botMessages", botMessages)}
          />
        )}
        {supported.has("activation.whenOthersMentioned") && (
          <SegmentedSettingRow
            field="whenOthersMentioned"
            overridden={settingSource(snapshot, "activation.whenOthersMentioned") === "overridden"}
            value={draft.activation.whenOthersMentioned}
            options={settingOptions(t, ["ignore", "respond"])}
            onChange={(whenOthersMentioned) =>
              change("activation.whenOthersMentioned", whenOthersMentioned)
            }
          />
        )}
      </SettingSection>

      <SettingSection title={t("channels.conversationSettings.sections.replies")}>
        {supported.has("replies.placement") && (
          <SegmentedSettingRow
            field="replies"
            overridden={settingSource(snapshot, "replies.placement") === "overridden"}
            value={draft.replies.placement}
            options={settingOptions(t, ["thread", "inline"])}
            onChange={(placement) => change("replies.placement", placement)}
          />
        )}
      </SettingSection>

      <SettingSection title={t("channels.conversationSettings.sections.session")}>
        {supported.has("session.reset") && (
          <SessionResetRows
            value={draft.session.reset}
            overridden={settingSource(snapshot, "session.reset") === "overridden"}
            onChange={(value) => change("session.reset", value)}
          />
        )}
      </SettingSection>

      <SettingSection title={t("channels.conversationSettings.sections.routing")}>
        {supported.has("routing.agentName") && (
          <SettingRow
            field="agent"
            overridden={settingSource(snapshot, "routing.agentName") === "overridden"}
            controlId={agentFieldId}
          >
            <Select
              value={draft.routing.agentName ?? "main"}
              onValueChange={(name) => change("routing.agentName", name)}
            >
              <SelectTrigger id={agentFieldId} className={CONTROL_WIDTH}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {routingOptions.map((name) => (
                  <SelectItem key={name} value={name}>
                    {name === "main"
                      ? t("channels.conversationSettings.mainAgent")
                      : [artifactLocalName(name), artifactOwnerId(name)]
                          .filter((part): part is string => Boolean(part && part !== "core"))
                          .join(" · ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </SettingRow>
        )}
      </SettingSection>
    </article>
  );
}

/** Every control in the right-hand column lands on the same width. */
const CONTROL_WIDTH = "w-full sm:w-52";

/**
 * A field name under `channels.conversationSettings.fields` / `.descriptions`.
 * Rows take the key rather than pre-resolved strings so the label and its
 * description can never be paired from different fields.
 */
type SettingFieldKey =
  | "enabled"
  | "respond"
  | "botMessages"
  | "whenOthersMentioned"
  | "replies"
  | "agent"
  | "sessionReset";

/**
 * Fields whose description carries a fact the label and the control do not
 * already show (docs/ui/secondary-text.md). Every other row is its label plus
 * its options, which say the same thing in fewer words — "Provider session
 * reset" is the exception because nothing on the row says memory is destroyed.
 */
const FIELDS_WITH_DESCRIPTION = new Set<SettingFieldKey>(["sessionReset"]);

function OverriddenBadge() {
  const { t } = useTranslation("settings");
  return <Badge variant="muted">{t("channels.conversationSettings.source.overridden")}</Badge>;
}

/**
 * Renders nothing when the provider supports none of its fields, so an
 * unsupported group leaves no empty heading behind. `Children.toArray` drops
 * the `false` a `supported.has(…) && <Row/>` guard yields.
 */
function SettingSection({ title, children }: { title?: string; children: ReactNode }) {
  const rows = Children.toArray(children);
  if (rows.length === 0) return null;
  return (
    <section className="border-t border-border first-of-type:border-t-0">
      {title && <h4 className="pt-4 pb-2 text-section text-foreground">{title}</h4>}
      <div className="divide-y divide-border">{rows}</div>
    </section>
  );
}

/**
 * One setting per full-width row: name and description on the left, the control
 * right-aligned at its own width. `controlId` binds the row's `<label>` to a
 * single labelable control; omit it for a control that names itself through
 * `aria-label` (a radiogroup has nothing to point `htmlFor` at).
 */
function SettingRow({
  field,
  overridden,
  controlId,
  children,
}: {
  field: SettingFieldKey;
  overridden: boolean;
  controlId?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation("settings");
  const label = t(`channels.conversationSettings.fields.${field}`);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          {controlId ? (
            <FieldLabel htmlFor={controlId}>{label}</FieldLabel>
          ) : (
            <FieldGroupLabel>{label}</FieldGroupLabel>
          )}
          {overridden && <OverriddenBadge />}
        </div>
        {FIELDS_WITH_DESCRIPTION.has(field) && (
          <p className="mt-1 text-aux text-muted-foreground">
            {t(`channels.conversationSettings.descriptions.${field}`)}
          </p>
        )}
      </div>
      <div className="w-full shrink-0 sm:w-auto">{children}</div>
    </div>
  );
}

/** Indented continuation of the row above it — the parameters of a chosen mode. */
function SettingSubRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3 pl-6">
      <p className="min-w-0 flex-1 text-ui text-foreground">{label}</p>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}

function SelectSettingRow({
  field,
  overridden,
  value,
  options,
  onChange,
}: {
  field: SettingFieldKey;
  overridden: boolean;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <SettingRow field={field} overridden={overridden} controlId={id}>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className={CONTROL_WIDTH}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </SettingRow>
  );
}

function SegmentedSettingRow({
  field,
  overridden,
  value,
  options,
  onChange,
}: {
  field: SettingFieldKey;
  overridden: boolean;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SettingRow field={field} overridden={overridden}>
      <SegmentedControl
        aria-label={t(`channels.conversationSettings.fields.${field}`)}
        value={value}
        size="sm"
        options={options}
        onValueChange={onChange}
      />
    </SettingRow>
  );
}

/**
 * The reset mode is the setting; the schedule it needs is a sub-row that only
 * exists for the mode that has one. Switching modes preserves the inactivity
 * amount so a round-trip through "Never" doesn't silently reset it to a week.
 */
function SessionResetRows({
  value,
  overridden,
  onChange,
}: {
  value: ProviderSessionResetPolicy;
  overridden: boolean;
  onChange: (value: ProviderSessionResetPolicy) => void;
}) {
  const { t } = useTranslation("settings");
  const modeId = useId();
  const idleMinutes = value.mode === "idle" ? value.idleMinutes : 10_080;
  const unit = idleMinutes % 1_440 === 0 ? "days" : idleMinutes % 60 === 0 ? "hours" : "minutes";
  const divisor = unit === "days" ? 1_440 : unit === "hours" ? 60 : 1;
  const amount = idleMinutes / divisor;

  return (
    <>
      <SettingRow field="sessionReset" overridden={overridden} controlId={modeId}>
        <Select
          value={value.mode}
          onValueChange={(mode) =>
            onChange(
              mode === "none"
                ? { mode: "none" }
                : mode === "idle"
                  ? { mode: "idle", idleMinutes }
                  : { mode: "daily", atHour: 4 },
            )
          }
        >
          <SelectTrigger id={modeId} className={CONTROL_WIDTH}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">
              {t("channels.conversationSettings.sessionReset.never")}
            </SelectItem>
            <SelectItem value="idle">
              {t("channels.conversationSettings.sessionReset.afterInactivity")}
            </SelectItem>
            <SelectItem value="daily">
              {t("channels.conversationSettings.sessionReset.daily")}
            </SelectItem>
          </SelectContent>
        </Select>
      </SettingRow>

      {value.mode === "idle" && (
        <SettingSubRow label={t("channels.conversationSettings.sessionReset.inactiveFor")}>
          <Input
            className="w-20"
            type="number"
            min={1}
            max={525_600}
            value={amount}
            aria-label={t("channels.conversationSettings.sessionReset.duration")}
            onChange={(event) => {
              const next = Math.max(1, Math.floor(Number(event.target.value) || 1));
              onChange({ mode: "idle", idleMinutes: Math.min(525_600, next * divisor) });
            }}
          />
          <Select
            value={unit}
            onValueChange={(nextUnit) => {
              const nextDivisor = nextUnit === "days" ? 1_440 : nextUnit === "hours" ? 60 : 1;
              onChange({
                mode: "idle",
                idleMinutes: Math.min(525_600, Math.max(1, Math.floor(amount * nextDivisor))),
              });
            }}
          >
            <SelectTrigger aria-label={t("channels.conversationSettings.sessionReset.unit")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="minutes">
                {t("channels.conversationSettings.sessionReset.minutes")}
              </SelectItem>
              <SelectItem value="hours">
                {t("channels.conversationSettings.sessionReset.hours")}
              </SelectItem>
              <SelectItem value="days">
                {t("channels.conversationSettings.sessionReset.days")}
              </SelectItem>
            </SelectContent>
          </Select>
        </SettingSubRow>
      )}

      {value.mode === "daily" && (
        <SettingSubRow label={t("channels.conversationSettings.sessionReset.resetAt")}>
          <Select
            value={String(value.atHour)}
            onValueChange={(hour) => onChange({ mode: "daily", atHour: Number(hour) })}
          >
            <SelectTrigger aria-label={t("channels.conversationSettings.sessionReset.dailyHour")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Array.from({ length: 24 }, (_, hour) => (
                <SelectItem key={hour} value={String(hour)}>{`${String(hour).padStart(
                  2,
                  "0",
                )}:00`}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-aux text-muted-foreground">
            {t("channels.conversationSettings.sessionReset.utc")}
          </span>
        </SettingSubRow>
      )}
    </>
  );
}

function settingOptions(t: TFunction<"settings">, values: string[]) {
  return values.map((value) => ({
    value,
    label: t(`channels.conversationSettings.options.${value}`),
  }));
}

function settingValue(settings: ConversationSettings, field: ConversationSettingField): unknown {
  switch (field) {
    case "enabled":
      return settings.enabled;
    case "activation.mode":
      return settings.activation.mode;
    case "activation.botMessages":
      return settings.activation.botMessages;
    case "activation.whenOthersMentioned":
      return settings.activation.whenOthersMentioned;
    case "replies.placement":
      return settings.replies.placement;
    case "routing.agentName":
      return settings.routing.agentName;
    case "session.reset":
      return settings.session.reset;
  }
}

function settingValuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function setSettingValue(
  settings: ConversationSettings,
  field: ConversationSettingField,
  value: unknown,
): void {
  switch (field) {
    case "enabled":
      settings.enabled = value as boolean;
      return;
    case "activation.mode":
      settings.activation.mode = value as ConversationSettings["activation"]["mode"];
      return;
    case "activation.botMessages":
      settings.activation.botMessages = value as ConversationSettings["activation"]["botMessages"];
      return;
    case "activation.whenOthersMentioned":
      settings.activation.whenOthersMentioned =
        value as ConversationSettings["activation"]["whenOthersMentioned"];
      return;
    case "replies.placement":
      settings.replies.placement = value as ConversationSettings["replies"]["placement"];
      return;
    case "routing.agentName":
      settings.routing.agentName = value === "main" ? null : (value as string | null);
      return;
    case "session.reset":
      settings.session.reset = structuredClone(value as ProviderSessionResetPolicy);
  }
}

function setPartialSettingValue(
  settings: PartialConversationSettings,
  field: ConversationSettingField,
  value: unknown,
): void {
  switch (field) {
    case "enabled":
      settings.enabled = value as boolean;
      return;
    case "activation.mode":
      (settings.activation ??= {}).mode = value as ConversationSettings["activation"]["mode"];
      return;
    case "activation.botMessages":
      (settings.activation ??= {}).botMessages =
        value as ConversationSettings["activation"]["botMessages"];
      return;
    case "activation.whenOthersMentioned":
      (settings.activation ??= {}).whenOthersMentioned =
        value as ConversationSettings["activation"]["whenOthersMentioned"];
      return;
    case "replies.placement":
      (settings.replies ??= {}).placement = value as ConversationSettings["replies"]["placement"];
      return;
    case "routing.agentName":
      (settings.routing ??= {}).agentName = value === null ? "main" : (value as string);
      return;
    case "session.reset":
      (settings.session ??= {}).reset = structuredClone(value as ProviderSessionResetPolicy);
  }
}

function settingSource(
  snapshot: ConversationSettingsSnapshot,
  field: ConversationSettingField,
): "overridden" | "default" {
  const overrides = snapshot.overrides;
  const overridden =
    field === "enabled"
      ? overrides.enabled !== undefined
      : field === "activation.mode"
        ? overrides.activation?.mode !== undefined
        : field === "activation.botMessages"
          ? overrides.activation?.botMessages !== undefined
          : field === "activation.whenOthersMentioned"
            ? overrides.activation?.whenOthersMentioned !== undefined
            : field === "replies.placement"
              ? overrides.replies?.placement !== undefined
              : field === "routing.agentName"
                ? overrides.routing?.agentName !== undefined
                : overrides.session?.reset !== undefined;
  if (overridden) return "overridden";
  return "default";
}

function hasOverrides(snapshot: ConversationSettingsSnapshot): boolean {
  return snapshot.supportedFields.some((field) => settingSource(snapshot, field) === "overridden");
}
