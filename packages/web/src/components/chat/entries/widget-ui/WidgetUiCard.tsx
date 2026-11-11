import { MessageProcessor } from "@a2ui/web_core/v0_9";
import { A2uiSurface } from "@a2ui/react/v0_9";
import type { TranscriptPart } from "@rome/api-types/chat";
import { type ComponentProps, useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { fetchJson } from "@/lib/fetch-json";
import { ROME_WIDGET_CATALOG_ID, romeWidgetCatalog } from "./catalog";

type WidgetUi = Extract<TranscriptPart, { type: "widget"; ui: unknown }>["ui"];

export interface WidgetUiCardProps {
  toolUseId: string;
  appId: string;
  ui: WidgetUi;
  bind?: Record<string, string>;
  /** The widget's line, shown when the card's data cannot be read. */
  text: string;
}

const appApi = (appId: string, path: string) => `/api/apps/${encodeURIComponent(appId)}/${path}`;

/**
 * A card an app described as data (`ui`), drawn with Rome's A2UI catalog.
 * Each `bind` is read from the app's API when the card mounts, so the card
 * shows the app's data as it stands. A button POSTs its event's context to
 * the app's API and reads every `bind` again; nothing is said in the chat.
 */
export function WidgetUiCard({ toolUseId, appId, ui, bind, text }: WidgetUiCardProps) {
  const { t } = useTranslation("chat");
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  // A re-render hands new objects for the same stored part; key on content
  // so the surface is built once per card.
  const bindKey = JSON.stringify(bind ?? {});
  const uiKey = JSON.stringify(ui);

  const load = useCallback(
    async (processor: MessageProcessor) => {
      const entries = Object.entries(JSON.parse(bindKey) as Record<string, string>);
      const values = await Promise.all(
        entries.map(([, path]) =>
          fetchJson<unknown>(appApi(appId, path), { fallback: "Could not read the card's data" }),
        ),
      );
      processor.processMessages(
        entries.map(([pointer], i) => ({
          version: "v0.9" as const,
          updateDataModel: { surfaceId: toolUseId, path: pointer, value: values[i] },
        })),
      );
    },
    [appId, bindKey, toolUseId],
  );

  const processor = useMemo(() => {
    const p = new MessageProcessor([romeWidgetCatalog], async (action) => {
      setBusy(true);
      try {
        await fetchJson<unknown>(appApi(appId, action.name), {
          method: "POST",
          json: action.context ?? {},
          fallback: "The card's button failed",
        });
        await load(p);
        setFailed(false);
      } catch {
        setFailed(true);
      } finally {
        setBusy(false);
      }
    });
    p.processMessages([
      {
        version: "v0.9",
        createSurface: { surfaceId: toolUseId, catalogId: ROME_WIDGET_CATALOG_ID },
      },
      {
        version: "v0.9",
        updateComponents: {
          surfaceId: toolUseId,
          components: (JSON.parse(uiKey) as WidgetUi).components,
        },
      },
    ]);
    return p;
  }, [appId, load, toolUseId, uiKey]);

  useEffect(() => {
    let live = true;
    load(processor).catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [load, processor]);

  useEffect(() => () => processor.dispose(), [processor]);

  const surface = processor.model.surfacesMap.get(toolUseId);
  return (
    <div
      className="flex w-full max-w-md flex-col gap-2 rounded-16 border border-border bg-surface px-4 py-3"
      aria-busy={busy}
      data-widget-app={appId}
    >
      {surface ? (
        <A2uiSurface
          surface={surface as unknown as ComponentProps<typeof A2uiSurface>["surface"]}
        />
      ) : null}
      {failed ? (
        <span className="text-aux text-destructive">
          {t("appComponent.widgetUnavailable", { text })}
        </span>
      ) : null}
    </div>
  );
}
