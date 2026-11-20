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
import { Link } from "react-router-dom";
import { Trans, useTranslation } from "react-i18next";
import { toast } from "sonner";
import type { TFunction } from "i18next";
import {
  ChevronDown,
  Hash,
  MessageSquare,
  Plus,
  RotateCcw,
  Search,
  User,
  Users,
} from "lucide-react";
import type {
  ChatSettingField,
  ChatSettings,
  ChatSettingsListItem,
  ChatSettingsSnapshot,
  PartialChatSettings,
  ProviderSessionResetPolicy,
} from "@rome/api-types/chat-settings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EmptyState,
  EmptyStateDescription,
  EmptyStateIcon,
  EmptyStateTitle,
} from "@/components/ui/empty-state";
import { FieldGroupLabel, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  List,
  ListRow,
  ListRowContent,
  ListRowDescription,
  ListRowTitle,
} from "@/components/ui/list-row";
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
import { MAIN_AGENT_ID } from "@rome/api-types/account-agents";

interface PageResponse {
  items: ChatSettingsListItem[];
  nextCursor?: string;
}

/** Coalesces a burst of edits — typing in the inactivity field — into one PATCH. */
const AUTOSAVE_DEBOUNCE_MS = 500;

/** Past this many chats with rules of their own, the list offers a search. */
const SEARCH_THRESHOLD = 6;

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

function keyOf(item: ChatSettingsListItem): string {
  const ref = item.snapshot.conversation.ref;
  return `${ref.connectionId}:${ref.chatId}`;
}

/** Chats grouped under the server or workspace they live in, in list order.
 *  A chat that lives in none, such as a direct message, groups under "". */
function groupByContainer(
  items: ChatSettingsListItem[],
): Array<{ container: string; items: ChatSettingsListItem[] }> {
  const groups = new Map<string, ChatSettingsListItem[]>();
  for (const item of items) {
    const container = item.snapshot.conversation.containerName ?? "";
    groups.set(container, [...(groups.get(container) ?? []), item]);
  }
  return [...groups].map(([container, grouped]) => ({ container, items: grouped }));
}

/**
 * The chat rules of one connection's chats, on that connection's page. Every
 * chat runs on the connection's defaults, which one line states. The list
 * holds only the chats a guardian gave rules of their own, and a dialog adds
 * another. A kind that offers no rules shows no section, which the page
 * decides from the connection's `chatRules`.
 * Vocabulary: docs/domains/chats.md#chat-rule.
 */
export function ChatRulesSection({ connectionId }: { connectionId: string }) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [connections, setConnections] = useState<ApiConnection[]>([]);
  const [agentNames, setAgentNames] = useState<string[]>([]);
  const [items, setItems] = useState<ChatSettingsListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const load = useCallback(
    async (cursor?: string, append = false) => {
      setLoading(true);
      setError("");
      try {
        const search = new URLSearchParams({ limit: "100", changed: "true" });
        search.set("connectionId", connectionId);
        if (query.trim()) search.set("query", query.trim());
        if (cursor) search.set("cursor", cursor);
        const [page, connectionList, agentPage] = await Promise.all([
          api<PageResponse>(`/api/chat-settings?${search}`),
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
    [connectionId, query],
  );

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 150);
    return () => window.clearTimeout(timer);
  }, [load]);

  const connection = connections.find((candidate) => candidate.id === connectionId);

  // Rome does not listen to a linkable account with no agent, whatever
  // agent a chat on it picks. A core that predates links omits `agent`.
  const silent = connection !== undefined && Boolean(connection.link) && connection.agent === null;
  // A linkable account's agent answers each chat on it that has no agent
  // of its own.
  const accountAgent =
    connection !== undefined && Boolean(connection.link) && typeof connection.agent === "string"
      ? connection.agent
      : undefined;

  // Stable identity: every row takes this as a dependency, so an inline
  // function here would change on each render and churn their save closures.
  const handleSaved = useCallback((snapshot: ChatSettingsSnapshot) => {
    setItems((current) =>
      current.map((candidate) =>
        candidate.snapshot.conversation.ref.connectionId ===
          snapshot.conversation.ref.connectionId &&
        candidate.snapshot.conversation.ref.chatId === snapshot.conversation.ref.chatId
          ? { ...candidate, snapshot, source: hasOverrides(snapshot) ? "configured" : "known" }
          : candidate,
      ),
    );
  }, []);

  const handleReset = useCallback((key: string) => {
    setItems((current) => current.filter((candidate) => keyOf(candidate) !== key));
    setOpenKey((current) => (current === key ? null : current));
  }, []);

  const handlePick = useCallback((picked: ChatSettingsListItem) => {
    const key = keyOf(picked);
    setItems((current) =>
      current.some((candidate) => keyOf(candidate) === key) ? current : [...current, picked],
    );
    setOpenKey(key);
    setAdding(false);
  }, []);

  const shownKeys = useMemo(() => new Set(items.map(keyOf)), [items]);
  const groups = useMemo(() => groupByContainer(items), [items]);
  const defaults = connection?.chatRuleDefaults;
  const defaultsSummary = defaults
    ? defaultsLine(t, defaults, new Set(connection?.chatRules ?? []), accountAgent)
    : "";

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 text-aux text-muted-foreground">
          {defaultsSummary && (
            <>
              <span className="text-foreground">
                {t("channels.conversationSettings.otherChats")}
              </span>{" "}
              {defaultsSummary}
            </>
          )}
        </p>
        <Button variant="outline" size="sm" onClick={() => setAdding(true)}>
          <Plus data-icon="inline-start" aria-hidden />
          {t("channels.conversationSettings.addChat")}
        </Button>
      </div>

      {(items.length > SEARCH_THRESHOLD || query) && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("channels.conversationSettings.searchPlaceholder")}
            aria-label={t("channels.conversationSettings.searchPlaceholder")}
            className="pl-9"
          />
        </label>
      )}

      {loading && items.length === 0 ? (
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
          <EmptyStateTitle>
            {query
              ? t("channels.conversationSettings.noMatches")
              : t("channels.conversationSettings.emptyTitle")}
          </EmptyStateTitle>
          {!query && (
            <EmptyStateDescription>
              {t("channels.conversationSettings.emptyDescription")}
            </EmptyStateDescription>
          )}
        </EmptyState>
      ) : (
        <>
          {groups.map((group) => (
            <div key={group.container} className="space-y-1.5">
              {group.container && (
                <h4 className="px-1 text-aux text-muted-foreground">{group.container}</h4>
              )}
              <List className="overflow-hidden rounded-12 border border-border bg-surface">
                {group.items.map((item) => (
                  <ChatRow
                    key={keyOf(item)}
                    item={item}
                    open={openKey === keyOf(item)}
                    onToggle={() =>
                      setOpenKey((current) => (current === keyOf(item) ? null : keyOf(item)))
                    }
                    agentNames={agentNames}
                    silent={silent}
                    accountAgent={accountAgent}
                    onSaved={handleSaved}
                    onReset={handleReset}
                  />
                ))}
              </List>
            </div>
          ))}
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

      <AddChatDialog
        open={adding}
        connectionId={connectionId}
        exclude={shownKeys}
        onClose={() => setAdding(false)}
        onPick={handlePick}
      />
    </section>
  );
}

/**
 * Picks a chat to give rules of its own. The chat joins the list open, at its
 * defaults, and the guardian changes a rule there.
 */
function AddChatDialog({
  open,
  connectionId,
  exclude,
  onClose,
  onPick,
}: {
  open: boolean;
  connectionId: string;
  /** The chats the list already shows. */
  exclude: ReadonlySet<string>;
  onClose: () => void;
  onPick: (item: ChatSettingsListItem) => void;
}) {
  const { t } = useTranslation("settings");
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<ChatSettingsListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      setError("");
      const search = new URLSearchParams({ limit: "50", connectionId });
      if (query.trim()) search.set("query", query.trim());
      api<PageResponse>(`/api/chat-settings?${search}`)
        .then((page) => {
          if (!cancelled) setItems(page.items);
        })
        .catch((err) => {
          if (!cancelled) setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [connectionId, open, query]);

  // A reopened dialog starts from a blank search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const choices = items.filter((item) => !exclude.has(keyOf(item)));

  return (
    <Dialog open={open} onClose={onClose} size="sm">
      <DialogHeader onClose={onClose} closeLabel={t("channels.conversationSettings.close")}>
        <DialogTitle>{t("channels.conversationSettings.addDialog.title")}</DialogTitle>
        <DialogDescription>
          {t("channels.conversationSettings.addDialog.description")}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="space-y-3 pb-6">
        <label className="relative block">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("channels.conversationSettings.searchPlaceholder")}
            aria-label={t("channels.conversationSettings.searchPlaceholder")}
            className="pl-9"
          />
        </label>
        {error ? (
          <Alert variant="destructive">
            <AlertDescription className="text-ui">{error}</AlertDescription>
          </Alert>
        ) : loading && choices.length === 0 ? (
          <div className="flex justify-center py-6">
            <Spinner label={t("channels.conversationSettings.loading")} />
          </div>
        ) : choices.length === 0 ? (
          <p className="py-6 text-center text-ui text-muted-foreground">
            {query
              ? t("channels.conversationSettings.noMatches")
              : t("channels.conversationSettings.findChats")}
          </p>
        ) : (
          <List className="max-h-80 overflow-y-auto rounded-12 border border-border">
            {choices.map((item) => {
              const chat = item.snapshot.conversation;
              return (
                <ListRow key={keyOf(item)} asChild interactive size="md">
                  <button type="button" onClick={() => onPick(item)}>
                    <ChatKindIcon kind={chat.kind} />
                    <ListRowContent>
                      <ListRowTitle className="truncate">{chat.displayName}</ListRowTitle>
                      <ListRowDescription className="truncate">
                        {[chat.containerName, t(`channels.conversationSettings.kinds.${chat.kind}`)]
                          .filter(Boolean)
                          .join(" · ")}
                      </ListRowDescription>
                    </ListRowContent>
                  </button>
                </ListRow>
              );
            })}
          </List>
        )}
      </DialogBody>
    </Dialog>
  );
}

/** The kind of chat: every row on a connection's page shares its brand. */
function ChatKindIcon({ kind }: { kind: string }) {
  const Icon =
    kind === "channel" ? Hash : kind === "dm" ? User : kind === "group" ? Users : MessageSquare;
  return (
    <span className="flex size-8 shrink-0 items-center justify-center rounded-8 bg-muted text-muted-foreground">
      <Icon className="size-4" aria-hidden />
    </span>
  );
}

function ChatRow({
  item,
  open,
  onToggle,
  agentNames,
  silent,
  accountAgent,
  onSaved,
  onReset,
}: {
  item: ChatSettingsListItem;
  open: boolean;
  onToggle: () => void;
  agentNames: string[];
  /** Set when Rome does not listen to the connection's account, which has no agent. */
  silent: boolean;
  /** The agent linked to the connection's account, which answers while the
   *  chat has no agent of its own. */
  accountAgent: string | undefined;
  onSaved: (snapshot: ChatSettingsSnapshot) => void;
  onReset: (key: string) => void;
}) {
  const { t } = useTranslation("settings");
  const agentFieldId = useId();
  const enabledFieldId = useId();
  const panelId = useId();
  const { snapshot } = item;
  const conversation = snapshot.conversation;
  const supported = new Set(snapshot.supportedFields);
  const agentOverridden = settingSource(snapshot, "routing.agentName") === "overridden";
  const [resetting, setResetting] = useState(false);
  const [draft, setDraft] = useState<ChatSettings>(() => structuredClone(snapshot.effective));
  const [saving, setSaving] = useState(false);
  // Whether the conversation follows its account's agent, kept beside
  // the draft: effective settings read the same for no choice and a pin to
  // main, so only the override tells them apart. `projectedFollow` is to
  // `followsLink` what `projected` is to the draft.
  const [followsLink, setFollowsLinkState] = useState(!agentOverridden);
  const followRef = useRef(!agentOverridden);
  const projectedFollow = useRef(!agentOverridden);
  const setFollowsLink = useCallback((follow: boolean) => {
    followRef.current = follow;
    setFollowsLinkState(follow);
  }, []);
  const routingOptions = Array.from(
    new Set(
      ["main", ...agentNames, ...(draft.routing.agentName ? [draft.routing.agentName] : [])].map(
        (name) => (name === MAIN_AGENT_ID ? "main" : name),
      ),
    ),
  );

  /**
   * The draft mirrored into a ref. The debounce timer and the unmount cleanup
   * both read the latest edit after the render that queued it, where the state
   * value would still be the previous one.
   */
  const draftRef = useRef(draft);
  const applyDraft = useCallback((next: ChatSettings) => {
    draftRef.current = next;
    setDraft(next);
  }, []);

  /**
   * Which fields have been touched since the last PATCH. Only the field names —
   * the values are read off the draft at flush time, so a field edited several
   * times in one burst contributes exactly one value: its last.
   */
  const dirty = useRef(new Set<ChatSettingField>());
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
  const projected = useRef<ChatSettings>(structuredClone(snapshot.effective));
  /** Batches enqueued but not yet settled; only the last one may resync `projected`. */
  const queued = useRef(0);

  const flush = useCallback(() => {
    const fields = dirty.current;
    dirty.current = new Set();
    // A field edited and put back before the debounce elapsed is not an edit.
    // Sending it would make the round-trip a durable override, which the UI has
    // no way to undo — so diff against projected state and drop no-ops.
    const sent: Array<[ChatSettingField, unknown, unknown]> = [];
    const set: PartialChatSettings = {};
    const clear: ChatSettingField[] = [];
    const ahead = structuredClone(projected.current);
    // Only a linked account has a link to follow.
    const follow = accountAgent !== undefined && followRef.current;
    const previousFollow = accountAgent !== undefined && projectedFollow.current;
    for (const field of fields) {
      const value = settingValue(draftRef.current, field);
      const previous = settingValue(projected.current, field);
      const linkChanged = field === "routing.agentName" && follow !== previousFollow;
      if (settingValuesEqual(value, previous) && !linkChanged) continue;
      if (field === "routing.agentName" && follow) clear.push(field);
      else setPartialSettingValue(set, field, value);
      setSettingValue(ahead, field, value);
      sent.push([field, value, previous]);
    }
    if (sent.length === 0) return inFlight.current;
    projected.current = ahead;
    const sentLink = sent.some(([field]) => field === "routing.agentName");
    if (sentLink) projectedFollow.current = follow;
    queued.current += 1;

    setSaving(true);
    inFlight.current = inFlight.current
      .then(() =>
        api<ChatSettingsSnapshot>("/api/chat-settings", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ref: conversation.ref, set, clear }),
        }),
      )
      .then((next) => {
        queued.current -= 1;
        // Only the last outstanding batch may adopt the response as the whole
        // projected state — an earlier one's response predates batches already
        // enqueued behind it.
        if (queued.current === 0) {
          projected.current = structuredClone(next.effective);
          projectedFollow.current = !overridesAgent(next);
        }
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
          if (field === "routing.agentName") {
            projectedFollow.current = previousFollow;
            if (mounted.current) setFollowsLink(previousFollow);
          }
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
              if (sentLink) setFollowsLink(follow);
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
  }, [applyDraft, conversation.ref, accountAgent, onSaved, setFollowsLink, t]);

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
    projectedFollow.current = !overridesAgent(snapshot);
    setFollowsLink(projectedFollow.current);
  }, [snapshot, applyDraft, setFollowsLink]);

  // Leaving the page mid-debounce must not silently discard the edit. Empty
  // deps on purpose: keyed on `flush` this would re-run on every parent render
  // and flush queued edits ahead of their debounce window.
  // Strict mode runs this effect's cleanup once before the real mount, so the
  // setup marks the row mounted again.
  useEffect(() => {
    mounted.current = true;
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
  function change(field: ChatSettingField, value: unknown) {
    const next = structuredClone(draftRef.current);
    setSettingValue(next, field, value);
    applyDraft(next);
    dirty.current.add(field);
    window.clearTimeout(flushTimer.current);
    flushTimer.current = window.setTimeout(() => void flush(), AUTOSAVE_DEBOUNCE_MS);
  }

  /**
   * Drops every value the chat holds, so it runs on the defaults and leaves
   * the list. An edit still waiting for its debounce is dropped with it, and
   * one already sent lands first, so the reset is the last write.
   */
  async function reset() {
    window.clearTimeout(flushTimer.current);
    dirty.current.clear();
    setResetting(true);
    try {
      await inFlight.current;
      await api<ChatSettingsSnapshot>("/api/chat-settings/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ref: conversation.ref }),
      });
      onReset(keyOf(item));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      if (mounted.current) setResetting(false);
    }
  }

  const summary = changedSummary(t, snapshot, draft, silent);

  return (
    <article>
      <h4>
        <ListRow asChild interactive size="md">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={open ? panelId : undefined}
            onClick={onToggle}
          >
            <ChatKindIcon kind={conversation.kind} />
            <ListRowContent>
              <ListRowTitle className="truncate">
                {conversation.displayName}
                {/* The icon is decorative, so the kind and the service reach
                    assistive tech here. */}
                <span className="sr-only">
                  {` · ${t(`channels.conversationSettings.kinds.${conversation.kind}`)} · ${serviceLabel(conversation.connectionKind)}`}
                </span>
              </ListRowTitle>
              <ListRowDescription className="truncate">{summary}</ListRowDescription>
            </ListRowContent>
            {saving && (
              <span className="shrink-0 text-aux text-muted-foreground">
                {t("channels.conversationSettings.saving")}
              </span>
            )}
            <ChevronDown
              className={`size-4 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-180" : ""}`}
              aria-hidden
            />
          </button>
        </ListRow>
      </h4>
      {open && (
        <div id={panelId} className="border-t border-border-subtle px-4 pb-3">
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
                options={settingOptions(t, ["mention", "all"], "replyRule.")}
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
                overridden={
                  settingSource(snapshot, "activation.whenOthersMentioned") === "overridden"
                }
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
            {supported.has("routing.agentName") && silent && (
              <SettingRow field="agent" overridden={false}>
                <div className="sm:max-w-xs">
                  <p className="text-ui text-foreground">{t("connections.accounts.noAgent")}</p>
                  <p className="mt-1 text-aux text-muted-foreground">
                    {t("channels.conversationSettings.silentAccount")}{" "}
                    <Trans
                      t={t}
                      i18nKey="channels.conversationSettings.silentAccountLink"
                      components={{
                        account: <Link to="/envoys" className="underline underline-offset-2" />,
                      }}
                    />
                    {agentOverridden &&
                      ` ${t("channels.conversationSettings.silentAccountOverride", {
                        agent: overriddenAgentLabel(snapshot.overrides.routing?.agentName),
                      })}`}
                  </p>
                </div>
              </SettingRow>
            )}
            {supported.has("routing.agentName") && !silent && (
              <SettingRow
                field="agent"
                overridden={settingSource(snapshot, "routing.agentName") === "overridden"}
                controlId={agentFieldId}
              >
                <Select
                  value={
                    accountAgent && followsLink ? FOLLOW_LINK : (draft.routing.agentName ?? "main")
                  }
                  onValueChange={(name) => {
                    if (accountAgent) setFollowsLink(name === FOLLOW_LINK);
                    change("routing.agentName", name === FOLLOW_LINK ? null : name);
                  }}
                >
                  <SelectTrigger id={agentFieldId} className={CONTROL_WIDTH}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {accountAgent && (
                      <SelectItem value={FOLLOW_LINK}>
                        {t("channels.conversationSettings.accountAgent", {
                          agent: overriddenAgentLabel(accountAgent),
                        })}
                      </SelectItem>
                    )}
                    {routingOptions.map((name) => (
                      <SelectItem key={name} value={name}>
                        {name !== "main"
                          ? agentLabel(name)
                          : accountAgent
                            ? "main"
                            : t("channels.conversationSettings.mainAgent")}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </SettingRow>
            )}
          </SettingSection>
          <div className="flex justify-end pt-3">
            <Button variant="ghost" size="sm" disabled={resetting} onClick={() => void reset()}>
              <RotateCcw data-icon="inline-start" aria-hidden />
              {t("channels.conversationSettings.resetToDefaults")}
            </Button>
          </div>
        </div>
      )}
    </article>
  );
}

/** The values the connection's other chats run on, as one line. */
function defaultsLine(
  t: TFunction<"settings">,
  defaults: ChatSettings,
  offered: ReadonlySet<ChatSettingField>,
  accountAgent: string | undefined,
): string {
  const parts: string[] = [];
  if (offered.has("activation.mode")) {
    parts.push(t(`channels.conversationSettings.options.replyRule.${defaults.activation.mode}`));
  }
  if (offered.has("replies.placement")) {
    parts.push(t(`channels.conversationSettings.summary.${defaults.replies.placement}`));
  }
  if (offered.has("routing.agentName") && accountAgent) {
    parts.push(
      t("channels.conversationSettings.summary.agent", {
        agent: overriddenAgentLabel(accountAgent),
      }),
    );
  }
  if (offered.has("session.reset")) parts.push(resetSummary(t, defaults.session.reset));
  return parts.join(" · ");
}

/** The rules a chat set for itself, as one line, in the order the panel lists them. */
function changedSummary(
  t: TFunction<"settings">,
  snapshot: ChatSettingsSnapshot,
  draft: ChatSettings,
  silent: boolean,
): string {
  const changed = (field: ChatSettingField) =>
    snapshot.supportedFields.includes(field) && settingSource(snapshot, field) === "overridden";
  const option = (field: "botMessages" | "whenOthersMentioned", value: string) =>
    `${t(`channels.conversationSettings.fields.${field}`)}: ${t(`channels.conversationSettings.options.${value}`)}`;
  const parts: string[] = [];
  if (changed("enabled")) {
    parts.push(t(`channels.conversationSettings.summary.${draft.enabled ? "on" : "off"}`));
  }
  if (changed("activation.mode")) {
    parts.push(t(`channels.conversationSettings.options.replyRule.${draft.activation.mode}`));
  }
  if (changed("activation.botMessages")) {
    parts.push(option("botMessages", draft.activation.botMessages));
  }
  if (changed("activation.whenOthersMentioned")) {
    parts.push(option("whenOthersMentioned", draft.activation.whenOthersMentioned));
  }
  if (changed("replies.placement")) {
    parts.push(t(`channels.conversationSettings.summary.${draft.replies.placement}`));
  }
  // An agent choice has no effect while the account has no agent.
  if (changed("routing.agentName") && !silent) {
    parts.push(
      t("channels.conversationSettings.summary.agent", {
        agent: overriddenAgentLabel(draft.routing.agentName),
      }),
    );
  }
  if (changed("session.reset")) parts.push(resetSummary(t, draft.session.reset));
  return parts.length > 0 ? parts.join(" · ") : t("channels.conversationSettings.summary.defaults");
}

function resetSummary(t: TFunction<"settings">, reset: ProviderSessionResetPolicy): string {
  if (reset.mode === "none") return t("channels.conversationSettings.summary.resetNever");
  if (reset.mode === "daily") {
    return t("channels.conversationSettings.summary.resetDaily", {
      time: `${String(reset.atHour).padStart(2, "0")}:00`,
    });
  }
  const minutes = reset.idleMinutes;
  const duration =
    minutes % 1_440 === 0
      ? t("channels.conversationSettings.summary.days", { count: minutes / 1_440 })
      : minutes % 60 === 0
        ? t("channels.conversationSettings.summary.hours", { count: minutes / 60 })
        : t("channels.conversationSettings.summary.minutes", { count: minutes });
  return t("channels.conversationSettings.summary.resetIdle", { duration });
}

/** A stored agent choice, where null and either spelling of main pin main. */
function overriddenAgentLabel(name: string | null | undefined): string {
  return !name || name === "main" || name === MAIN_AGENT_ID ? "main" : agentLabel(name);
}

/** An agent's name and, unless it is core, its owner. */
function agentLabel(name: string): string {
  return [artifactLocalName(name), artifactOwnerId(name)]
    .filter((part): part is string => Boolean(part && part !== "core"))
    .join(" · ");
}

/** Whether the conversation has an agent choice of its own, a main pin included. */
function overridesAgent(snapshot: ChatSettingsSnapshot): boolean {
  return settingSource(snapshot, "routing.agentName") === "overridden";
}

/** The agent picker's value for "no agent of its own", which follows the link. */
const FOLLOW_LINK = "@linked";

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

/** Marks a rule changed from the connection's default, with the words for
 *  assistive tech. */
function ChangedDot() {
  const { t } = useTranslation("settings");
  const label = t("channels.conversationSettings.changed");
  return (
    <span className="inline-flex items-center" title={label}>
      <span className="size-1.5 rounded-full bg-primary" aria-hidden />
      <span className="sr-only">{label}</span>
    </span>
  );
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
    <section className="pt-3 first-of-type:pt-1">
      {title && <h5 className="pb-1 text-aux text-muted-foreground">{title}</h5>}
      <div className="divide-y divide-border-subtle">{rows}</div>
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
          {overridden && <ChangedDot />}
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

function settingOptions(t: TFunction<"settings">, values: string[], keyPrefix = "") {
  return values.map((value) => ({
    value,
    label: t(`channels.conversationSettings.options.${keyPrefix}${value}`),
  }));
}

function settingValue(settings: ChatSettings, field: ChatSettingField): unknown {
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

function setSettingValue(settings: ChatSettings, field: ChatSettingField, value: unknown): void {
  switch (field) {
    case "enabled":
      settings.enabled = value as boolean;
      return;
    case "activation.mode":
      settings.activation.mode = value as ChatSettings["activation"]["mode"];
      return;
    case "activation.botMessages":
      settings.activation.botMessages = value as ChatSettings["activation"]["botMessages"];
      return;
    case "activation.whenOthersMentioned":
      settings.activation.whenOthersMentioned =
        value as ChatSettings["activation"]["whenOthersMentioned"];
      return;
    case "replies.placement":
      settings.replies.placement = value as ChatSettings["replies"]["placement"];
      return;
    case "routing.agentName":
      settings.routing.agentName = value === "main" ? null : (value as string | null);
      return;
    case "session.reset":
      settings.session.reset = structuredClone(value as ProviderSessionResetPolicy);
  }
}

function setPartialSettingValue(
  settings: PartialChatSettings,
  field: ChatSettingField,
  value: unknown,
): void {
  switch (field) {
    case "enabled":
      settings.enabled = value as boolean;
      return;
    case "activation.mode":
      (settings.activation ??= {}).mode = value as ChatSettings["activation"]["mode"];
      return;
    case "activation.botMessages":
      (settings.activation ??= {}).botMessages = value as ChatSettings["activation"]["botMessages"];
      return;
    case "activation.whenOthersMentioned":
      (settings.activation ??= {}).whenOthersMentioned =
        value as ChatSettings["activation"]["whenOthersMentioned"];
      return;
    case "replies.placement":
      (settings.replies ??= {}).placement = value as ChatSettings["replies"]["placement"];
      return;
    case "routing.agentName":
      (settings.routing ??= {}).agentName = value === null ? "main" : (value as string);
      return;
    case "session.reset":
      (settings.session ??= {}).reset = structuredClone(value as ProviderSessionResetPolicy);
  }
}

function settingSource(
  snapshot: ChatSettingsSnapshot,
  field: ChatSettingField,
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

function hasOverrides(snapshot: ChatSettingsSnapshot): boolean {
  return snapshot.supportedFields.some((field) => settingSource(snapshot, field) === "overridden");
}
