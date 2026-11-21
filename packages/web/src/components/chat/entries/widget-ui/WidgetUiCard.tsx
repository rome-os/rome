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
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { isLocationCard, mayAutoShare, SHARE_LOCATION_EVENT } from "@rome/api-types/location-card";
import { ROME_STRINGS_KEY } from "@rome/api-types/prompt-card";
import { postWidgetEvent, type WidgetEventOutcome } from "@/lib/chat-api";
import { formatAccuracy, geolocationPermission, readDevicePosition } from "@/lib/device-location";
import { fetchJson } from "@/lib/fetch-json";
import { ChatNotice } from "@/components/chat/ChatNotice";
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
// language: the question card's labels, and the device connect card's and the
// share-location card's.
const HOST_STRINGS: Record<string, string> = {
  send: "questionCard.send",
  dismiss: "questionCard.dismiss",
  typeOwn: "questionCard.typeOwn",
  addOwn: "questionCard.addOwn",
  typeAnswer: "questionCard.typeAnswer",
  optional: "questionCard.optional",
  connect: "deviceConnectCard.connect",
  notNow: "deviceConnectCard.notNow",
  deviceConnectNote: "deviceConnectCard.note",
  share: "locationCard.share",
  shareLocationTitle: "locationCard.title",
};

/**
 * A card's data model with Rome's own words (`/romeStrings/<name>`, each
 * stored with its English) in the guardian's language, where this reader
 * knows the name; the English stays otherwise.
 */
export function withRomeWords(
  data: Record<string, unknown> | undefined,
  translate: (key: string) => string,
): Record<string, unknown> | undefined {
  const words = data?.[ROME_STRINGS_KEY];
  if (!data || !words || typeof words !== "object" || Array.isArray(words)) return data;
  const localized = Object.fromEntries(
    Object.entries(words as Record<string, unknown>).map(([name, english]) => {
      const key = HOST_STRINGS[name];
      const word = key ? translate(key) : "";
      return [name, word || english];
    }),
  );
  return { ...data, [ROME_STRINGS_KEY]: localized };
}

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
  const [autoSent, setAutoSent] = useState<number | null>(null);
  const [blockedLink, setBlockedLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [locating, setLocating] = useState(false);
  const [sent, setSent] = useState(false);
  const result = waiting?.result;
  const dismissed = result?.dismissed === true;
  const widgetHost = useContext(WidgetHostContext);
  const widgetHostRef = useRef(widgetHost);
  widgetHostRef.current = widgetHost;
  // A share-location card core marked for it, which the browser may already
  // read, answers itself: while that is decided and done it shows no
  // buttons. Core marks only a card the guardian's own message asked for.
  const autoShare = mayAutoShare(ui as { data?: Record<string, unknown> });
  const [autoSharing, setAutoSharing] = useState(
    () =>
      autoShare &&
      appId === "core" &&
      waiting !== undefined &&
      result === undefined &&
      widgetHost.readOnly !== true &&
      isLocationCard(cardComponents(ui)),
  );
  // A view that only shows the chat sends nothing, so its cards stay locked.
  const locked = result !== undefined || sent || autoSharing || widgetHost.readOnly === true;
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
  // Only core's own card is the share-location card: an app's card that
  // names the same event gets no position and never shares by itself.
  const locationCard = useMemo(
    () => appId === "core" && isLocationCard(parts.components),
    [appId, parts],
  );
  const answerable = waits && result === undefined && !sent && widgetHost.readOnly !== true;
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

  const { processor, drawable, fire } = useMemo(() => {
    // `auto` is a share the card sends itself, with no press: a refusal from
    // core then says nothing, since another client answered first.
    const fire = async (
      action: { name: string; context?: Record<string, unknown> },
      auto = false,
    ) => {
      // Core decides what every event means; the card only sends it. A turn
      // the event starts reaches the chat through live events.
      if (inFlight.current || widgetHostRef.current.readOnly) return;
      inFlight.current = true;
      setBusy(true);
      const host = waitingRef.current;
      let outcome: WidgetEventOutcome = { ok: false, status: 0 };
      try {
        let context = action.context ?? {};
        // Share on the share-location card carries the device's position,
        // read on the press so the browser asks for permission then.
        if (action.name === SHARE_LOCATION_EVENT && locationCard) {
          setLocating(true);
          const read = await readDevicePosition().finally(() => setLocating(false));
          if (!read.ok) {
            outcome = { ok: false, status: 0, error: t(`locationCard.${read.failure}`) };
            throw new Error("No position to share");
          }
          context = { ...context, ...read.position };
        }
        outcome = await postWidgetEvent(widgetId, {
          name: action.name,
          context,
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
        if (outcome.answered && host) {
          setSent(true);
          // A share sent by itself shows its quiet line until the stored
          // answer arrives.
          if (auto && typeof context.accuracy === "number") setAutoSent(context.accuracy);
        } else {
          await load(p);
          setFailed(false);
        }
      } catch {
        // A refused event says the send failed; a read after it says the data did.
        if (outcome.ok) setFailed(true);
        else if (!auto || outcome.status === 0) setSendFailed(outcome.error ?? "");
      } finally {
        host?.onSettled?.(outcome);
        widgetHostRef.current.onSettled?.(outcome);
        inFlight.current = false;
        setBusy(false);
        if (auto) setAutoSharing(false);
      }
    };
    const p = new MessageProcessor([romeWidgetCatalog], (action) => fire(action));
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
      const data = withRomeWords((JSON.parse(uiKey) as WidgetUi).data, t);
      if (data) {
        p.processMessages([
          { version: "v0.9", updateDataModel: { surfaceId: toolUseId, path: "/", value: data } },
        ]);
      }
    } catch {
      return { processor: p, drawable: false, fire };
    }
    return { processor: p, drawable: true, fire };
  }, [load, widgetId, toolUseId, uiKey, parts, valid, locationCard, t]);

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

  // A share-location card core marked answers itself where the browser
  // already lets this site read the position, and only in the tab the
  // guardian is looking at; an unmarked one waits for Share.
  // Where the browser refuses, the card says so and Not now declines.
  useEffect(() => {
    if (!locationCard || !answerable) {
      setAutoSharing(false);
      return;
    }
    let live = true;
    let stopWaiting = () => {};
    void geolocationPermission().then((permission) => {
      if (!live) return;
      if (permission === "denied") setSendFailed(t("locationCard.denied"));
      if (!autoShare || permission !== "granted" || autoShared.has(widgetId)) {
        setAutoSharing(false);
        return;
      }
      const share = () => {
        if (document.visibilityState !== "visible" || autoShared.has(widgetId)) return;
        autoShared.add(widgetId);
        stopWaiting();
        void fire({ name: SHARE_LOCATION_EVENT, context: { auto: true } }, true);
      };
      document.addEventListener("visibilitychange", share);
      stopWaiting = () => document.removeEventListener("visibilitychange", share);
      share();
    });
    return () => {
      live = false;
      stopWaiting();
    };
  }, [locationCard, answerable, autoShare, widgetId, fire, t]);

  const surface = drawable ? processor.model.surfacesMap.get(toolUseId) : undefined;
  const undrawable = (
    <span className="text-aux text-destructive">
      {t("appComponent.widgetUndrawable", { text })}
    </span>
  );
  // A share the card made by itself is no question the guardian answered:
  // while it runs nothing shows, and once core has it, one quiet line.
  if (locationCard && autoSharing && sendFailed === false) return null;
  const autoOutcome =
    result?.auto === true
      ? result
      : autoSent !== null && result === undefined
        ? { status: "shared", accuracyMeters: Math.round(autoSent) }
        : null;
  if (locationCard && autoOutcome) {
    // A centered line across the transcript, as a model switch is.
    return <ChatNotice className="mb-0">{locationOutcome(autoOutcome, t)}</ChatNotice>;
  }
  return (
    <div
      tabIndex={waiting ? -1 : undefined}
      className="flex w-full max-w-md flex-col gap-2 rounded-12 border border-border bg-surface px-4 py-3"
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
          {locationCard && result !== undefined
            ? locationOutcome(result, t)
            : t(
                result === undefined
                  ? "questionCard.sent"
                  : dismissed
                    ? "questionCard.dismissed"
                    : "questionCard.answered",
              )}
        </span>
      ) : locating ? (
        <span className="text-aux text-muted-foreground">{t("locationCard.locating")}</span>
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

/** The share-location cards this page answered by itself, so a card drawn
 *  again does not send a second share. */
const autoShared = new Set<string>();

/** A card's components as stored, or none when its data cannot be read. */
function cardComponents(ui: WidgetUi): unknown[] {
  const components = (ui as Partial<WidgetUi> | null)?.components;
  return Array.isArray(components) ? components : [];
}

/** How an answered share-location card ended: shared, with how precise the
 *  position was, or not shared (declined, or skipped by a message). */
function locationOutcome(result: Record<string, unknown>, t: TFunction<"chat">) {
  const accuracy = result.accuracyMeters;
  return result.status === "shared" && typeof accuracy === "number"
    ? t("locationCard.shared", { accuracy: formatAccuracy(accuracy) })
    : t("locationCard.notShared");
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
