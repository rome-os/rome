import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { fetchSharedChat, type SharedChatPayload } from "@/lib/chat-api";
import { PublicFreeGrid } from "./PublicFreeGrid";

type LoadState =
  | { status: "loading" }
  | { status: "missing" }
  | { status: "error" }
  | { status: "ready"; payload: SharedChatPayload };

// Public, login-free entry point for a shared chat. Mounted OUTSIDE the auth
// shell (App.tsx), so a guest reaches it with no session. Renders the frozen
// chat + live app/projects widgets via PublicFreeGrid.
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const { t } = useTranslation("chat");
  const [state, setState] = useState<LoadState>({ status: "loading" });

  useEffect(() => {
    if (!token) {
      setState({ status: "missing" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    fetchSharedChat(token)
      .then((payload) => {
        if (cancelled) return;
        setState(payload ? { status: "ready", payload } : { status: "missing" });
      })
      .catch(() => {
        if (!cancelled) setState({ status: "error" });
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const title = state.status === "ready" ? state.payload.title : null;
  useEffect(() => {
    if (!title) return;
    const previous = document.title;
    document.title = `${title} · Rome`;
    return () => {
      document.title = previous;
    };
  }, [title]);

  const chat = useMemo(() => {
    if (state.status !== "ready") return null;
    const { snapshot } = state.payload;
    return {
      messages: snapshot.messages,
      mainSessionId: snapshot.mainSessionId,
      traces: snapshot.traces ?? {},
    };
  }, [state]);

  if (state.status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center pb-safe pt-safe text-ui text-muted-foreground">
        {t("share.loading", "Loading…")}
      </div>
    );
  }

  if (state.status === "missing" || state.status === "error" || !chat) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-2 px-6 pb-safe pt-safe text-center">
        <h1 className="text-title text-foreground">
          {t("share.unavailableTitle", "This shared chat is unavailable")}
        </h1>
        <p className="max-w-md text-ui text-muted-foreground">
          {t("share.unavailableBody", "The link may have been revoked or is no longer valid.")}
        </p>
      </div>
    );
  }

  return <PublicFreeGrid placements={state.payload.layout ?? []} token={token!} chat={chat} />;
}
