import { useEffect } from "react";
import { appBuildingChat } from "./fixtures/app-building-chat";

const openingPrompt = appBuildingChat.turns[0].prompt;
if (typeof openingPrompt !== "string") {
  throw new Error("The guided tour requires a text opening prompt in appBuildingChat.");
}
export const TOUR_PROMPT = openingPrompt;

export function useTourTyping(insertText: (text: string) => void) {
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tour") !== "chat") return;
    let parentOrigin: string;
    try {
      parentOrigin = new URL(document.referrer).origin;
    } catch {
      return;
    }
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const data = event.data;
      if (
        data?.type !== "rome:tour-typing" ||
        typeof data.active !== "boolean" ||
        typeof data.progress !== "number" ||
        !Number.isFinite(data.progress)
      )
        return;
      const count = Math.floor(Math.max(0, Math.min(1, data.progress)) * TOUR_PROMPT.length);
      insertText(TOUR_PROMPT.slice(0, count));
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "rome:tour-composer-ready" }, parentOrigin);
    return () => {
      window.removeEventListener("message", receive);
    };
  }, [insertText]);
}
