import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { A2uiSurface } from "@a2ui/react/v0_9";
import type { TranscriptPart } from "@rome/api-types/chat";
import {
  type ComponentProps,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { postWidgetEvent, type WidgetEventOutcome } from "@/lib/chat-api";
import { fetchJson } from "@/lib/fetch-json";
import { CardBoundary } from "./CardBoundary";
import { isDrawableCard } from "./drawable";
import { WidgetHostContext } from "./turn-fields";
import {
  ROME_WIDGET_CATALOG_ID,
  romeWidgetCatalog,
  WidgetBusyContext,
  WidgetClearsContext,
  WidgetLockedContext,
} from "./catalog";

type WidgetUi = Extract<TranscriptPart, { type: "widget"; ui: unknown }>["ui"];

export interface WidgetUiCardProps {
  /** The widget's id: the id of the message that holds it. Its events go to core by it. */
  widgetId: string;
  toolUseId: string;
  appId: string;
  ui: WidgetUi;
  bind?: Record<string, string>;
  /** The widget's line, shown when the card's data cannot be read. */
  text: string;
  /** Set for a card the agent waits on. `result` is the stored answer once
   *  there is one, which locks the card; `onSettled` hears what core said to
   *  each event. */
  waiting?: {
    result?: Record<string, unknown>;
    onSettled?: (outcome: WidgetEventOutcome) => void;
  };
}

// Rome's own strings a card names with `{ string }`, shown in the guardian's
// language. They are the question card's labels.
const HOST_STRINGS: Record<string, string> = {
  send: "questionCard.send",
  dismiss: "questionCard.dismiss",
  typeOwn: "questionCard.typeOwn",
  addOwn: "questionCard.addOwn",
  typeAnswer: "questionCard.typeAnswer",
  optional: "questionCard.optional",
};

/** The card's components with each `{ string }` replaced by its translation,
 *  since A2UI itself only knows literals and paths. */
function withHostStrings(value: unknown, translate: (key: string) => string): unknown {
  if (Array.isArray(value)) return value.map((v) => withHostStrings(v, translate));
  if (!value || typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1 && typeof o.string === "string") {
    return HOST_STRINGS[o.string] ? translate(HOST_STRINGS[o.string]) : "";
  }
  // A button's `action` is sent to the app or the agent as it is written.
  return Object.fromEntries(
    keys.map((k) => [k, k === "action" ? o[k] : withHostStrings(o[k], translate)]),
  );
}

const appApi = (appId: string, path: string) => `/api/apps/${encodeURIComponent(appId)}/${path}`;

/** Each component's `clears`, taken out of the components, since A2UI's
 *  schemas have no such field. */
function splitClears(components: unknown[]): {
  components: unknown[];
  clears: ReadonlyMap<string, string>;
} {
  const clears = new Map<string, string>();
  const rest = components.map((c) => {
    const o = c as { id?: unknown; clears?: { path?: unknown } };
    if (!o || typeof o !== "object" || o.clears === undefined) return c;
    const { clears: target, ...component } = o;
    if (typeof o.id === "string" && typeof target?.path === "string") clears.set(o.id, target.path);
    return component;
  });
  return { components: rest, clears };
}

/**
 * A card an app described as data (`ui`), drawn with Rome's A2UI catalog.
 * Each `bind` is read from the app's API when the card mounts, so the card
 * shows the app's data as it stands. A press sends its event to core, which
 * calls the app; the card then reads every `bind` again, and nothing is said
 * in the chat.
 */
export function WidgetUiCard({
  widgetId,
  toolUseId,
  appId,
  ui,
  bind,
  text,
  waiting,
}: WidgetUiCardProps) {
  const { t } = useTranslation("chat");
  const [failed, setFailed] = useState(false);
  // A refused event, with why when core says.
  const [sendFailed, setSendFailed] = useState<string | false>(false);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const result = waiting?.result;
  const dismissed = result?.dismissed === true;
  const widgetHost = useContext(WidgetHostContext);
  const widgetHostRef = useRef(widgetHost);
  widgetHostRef.current = widgetHost;
  // A view that only shows the chat sends nothing, so its cards stay locked.
  const locked = result !== undefined || sent || widgetHost.readOnly === true;
  const waitingRef = useRef(waiting);
  waitingRef.current = waiting;
  // Buttons wait for the first read: a press before it would post a context
  // whose paths are not loaded yet.
  const [ready, setReady] = useState(false);
  // A re-render hands new objects for the same stored part; key on content
  // so the surface is built once per card.
  const bindKey = JSON.stringify(bind ?? {});
  const uiKey = JSON.stringify(ui);

  const inFlight = useRef(false);
  const parts = useMemo(() => {
    const components = (JSON.parse(uiKey) as Partial<WidgetUi> | null)?.components;
    // A part read back from storage can lack its components; it then draws
    // nothing and shows the fallback line, below.
    return splitClears(
      Array.isArray(components) ? (withHostStrings(components, t) as unknown[]) : [],
    );
  }, [uiKey, t]);
  const waits = waiting !== undefined;
  // Only the newest read writes the data: a slow first read must not land
  // after a press's refresh and put back an older value.
  const reads = useRef(0);
  const valid = useMemo(
    () => isDrawableCard(appId, JSON.parse(uiKey), JSON.parse(bindKey), waits),
    [appId, uiKey, bindKey, waits],
  );

  const load = useCallback(
    async (processor: MessageProcessor) => {
      if (!valid) return;
      const read = ++reads.current;
      const entries = Object.entries(JSON.parse(bindKey) as Record<string, string>);
      const values = await Promise.all(
        entries.map(([, path]) =>
          fetchJson<unknown>(appApi(appId, path), { fallback: "Could not read the card's data" }),
        ),
      );
      if (read !== reads.current) return;
      processor.processMessages(
        entries.map(([pointer], i) => ({
          version: "v0.9" as const,
          updateDataModel: { surfaceId: toolUseId, path: pointer, value: values[i] },
        })),
      );
    },
    [appId, bindKey, toolUseId, valid],
  );

  const { processor, drawable } = useMemo(() => {
    const p = new MessageProcessor([romeWidgetCatalog], async (action) => {
      // Core decides what every event means; the card only sends it. A turn
      // the event starts reaches the chat through live events.
      if (inFlight.current || widgetHostRef.current.readOnly) return;
      inFlight.current = true;
      setBusy(true);
      const host = waitingRef.current;
      let outcome: WidgetEventOutcome = { ok: false, status: 0 };
      try {
        outcome = await postWidgetEvent(widgetId, {
          name: action.name,
          context: action.context ?? {},
          turn: widgetHostRef.current.turnFields(),
        });
        if (!outcome.ok) throw new Error(`The widget's event failed: ${outcome.status}`);
        // A link the reply names opens; a card core says is answered locks,
        // and any other card reads its data again.
        setSendFailed(false);
        if (outcome.open) {
          // A browser lets a page open a tab only right after a click, and the
          // reply may come later: a blocked tab shows as a link instead.
          const tab = window.open(outcome.open, "_blank");
          if (tab) tab.opener = null;
          else setBlockedLink(outcome.open);
        }
        if (outcome.answered && host) setSent(true);
        else {
          await load(p);
          setFailed(false);
        }
      } catch {
        // A refused event says the send failed; a read after it says the data did.
        if (outcome.ok) setFailed(true);
        else setSendFailed(outcome.error ?? "");
      } finally {
        host?.onSettled?.(outcome);
        widgetHostRef.current.onSettled?.(outcome);
        inFlight.current = false;
        setBusy(false);
      }
    });
    // A2UI refuses some cards core accepts, such as a path through
    // `constructor`; such a card shows its fallback line instead of throwing
    // out of the transcript.
    try {
      if (!valid) throw new Error("The card fails core's check");
      p.processMessages([
        {
          version: "v0.9",
          createSurface: { surfaceId: toolUseId, catalogId: ROME_WIDGET_CATALOG_ID },
        },
        {
          version: "v0.9",
          updateComponents: {
            surfaceId: toolUseId,
            components: parts.components as never,
          },
        },
      ]);
      const data = (JSON.parse(uiKey) as WidgetUi).data;
      if (data) {
        p.processMessages([
          { version: "v0.9", updateDataModel: { surfaceId: toolUseId, path: "/", value: data } },
        ]);
      }
    } catch {
      return { processor: p, drawable: false };
    }
    return { processor: p, drawable: true };
  }, [load, widgetId, toolUseId, uiKey, parts, valid]);

  // An answered card shows what the guardian sent, which core keeps as `card`.
  // A dismissed card was never answered, so it shows nothing picked rather
  // than its defaults.
  const answeredKey = JSON.stringify(result?.card ?? sentCard(result) ?? (dismissed ? [] : null));
  useEffect(() => {
    const card = JSON.parse(answeredKey) as unknown;
    if (card === null) return;
    try {
      processor.processMessages([
        {
          version: "v0.9",
          updateDataModel: { surfaceId: toolUseId, path: "/answers", value: card },
        },
      ]);
    } catch {
      setFailed(true);
    }
  }, [answeredKey, processor, toolUseId]);

  useEffect(() => {
    let live = true;
    load(processor)
      .catch(() => live && setFailed(true))
      .finally(() => live && setReady(true));
    return () => {
      live = false;
    };
  }, [load, processor]);

  useEffect(() => () => processor.dispose(), [processor]);

  const surface = drawable ? processor.model.surfacesMap.get(toolUseId) : undefined;
  const undrawable = (
    <span className="text-aux text-destructive">
      {t("appComponent.widgetUndrawable", { text })}
    </span>
  );
  return (
    <div
      tabIndex={waiting ? -1 : undefined}
      className="flex w-full max-w-md flex-col gap-2 rounded-16 border border-border bg-surface px-4 py-3"
      aria-busy={busy}
      data-widget-app={appId}
      data-chat-pending-card={waiting && !locked ? "" : undefined}
    >
      {surface ? (
        <WidgetLockedContext.Provider value={locked}>
          <WidgetBusyContext.Provider value={busy || !ready}>
            <WidgetClearsContext.Provider value={parts.clears}>
              <CardBoundary fallback={undrawable}>
                <A2uiSurface
                  surface={surface as unknown as ComponentProps<typeof A2uiSurface>["surface"]}
                />
              </CardBoundary>
            </WidgetClearsContext.Provider>
          </WidgetBusyContext.Provider>
        </WidgetLockedContext.Provider>
      ) : drawable ? null : (
        undrawable
      )}
      {/* A view that only shows the chat locks an open card without sending
          it, so it says how the card ended only when it did. */}
      {waiting && (result !== undefined || sent) ? (
        <span className="text-aux text-muted-foreground">
          {t(
            result === undefined
              ? "questionCard.sent"
              : dismissed
                ? "questionCard.dismissed"
                : "questionCard.answered",
          )}
        </span>
      ) : null}
      {blockedLink ? (
        <a
          href={blockedLink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-aux text-primary underline underline-offset-2"
          onClick={() => setBlockedLink(null)}
        >
          {t("appComponent.widgetOpenLink")}
        </a>
      ) : null}
      {sendFailed !== false ? (
        <span className="text-aux text-destructive">
          {sendFailed || t("stream.errors.sendFallback")}
        </span>
      ) : failed ? (
        <span className="text-aux text-destructive">
          {t("appComponent.widgetUnavailable", { text })}
        </span>
      ) : null}
    </div>
  );
}

/**
 * What the card sent, before core has stored it as `card`: answers in the
 * card's own shape (`values` and `text`, no `questionId`), as a reader that
 * has not heard back from core still holds them.
 */
function sentCard(result: Record<string, unknown> | undefined): unknown[] | null {
  const answers = result?.answers;
  if (!Array.isArray(answers) || answers.length === 0) return null;
  const ownShape = answers.every(
    (a) => !!a && typeof a === "object" && !("questionId" in a) && "values" in a,
  );
  return ownShape ? answers : null;
}
