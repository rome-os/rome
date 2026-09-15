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
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let count = 0;
    let target = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    const stop = () => {
      clearInterval(timer);
      timer = undefined;
    };
    const advance = () => {
      count = Math.min(TOUR_PROMPT.length, Math.max(count + 2, target));
      insertText(TOUR_PROMPT.slice(0, count));
      if (count === TOUR_PROMPT.length) stop();
    };
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
      if (!data.active) {
        stop();
        return;
      }
      target = Math.floor(Math.max(0, Math.min(1, data.progress)) * TOUR_PROMPT.length);
      if (reducedMotion.matches) target = TOUR_PROMPT.length;
      if (count < TOUR_PROMPT.length) {
        advance();
        if (!timer && count < TOUR_PROMPT.length) timer = setInterval(advance, 24);
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "rome:tour-composer-ready" }, parentOrigin);
    return () => {
      stop();
      window.removeEventListener("message", receive);
    };
  }, [insertText]);
}
