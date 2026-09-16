import { useCallback, useEffect, useRef, useState } from "react";
import { findScrollableYAncestor } from "../src/lib/scroll-container";
import {
  useStickToBottom as useDashboardScroll,
  type UseStickToBottomOptions,
} from "../src/hooks/use-stick-to-bottom";

export * from "../src/hooks/use-stick-to-bottom";

const stayAtStart = () => {};

export function useStickToBottom(options: UseStickToBottomOptions = {}) {
  const guided = new URLSearchParams(window.location.search).get("tour") === "build";
  const scroll = useDashboardScroll({ ...options, ...(guided ? { initialStuck: false } : {}) });
  const [content, setContent] = useState<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(false);
  const containerRef = useRef<HTMLElement | null>(null);
  const progressRef = useRef(0);
  const scrollRef = useCallback((node: HTMLElement | null) => {
    containerRef.current = node;
  }, []);

  useEffect(() => {
    if (!guided || !content) return;
    let parentOrigin: string;
    try {
      parentOrigin = new URL(document.referrer).origin;
    } catch {
      return;
    }
    const apply = () => {
      const container = containerRef.current ?? findScrollableYAncestor(content);
      const scroller = container ?? document.documentElement;
      const height = container ? scroller.clientHeight : window.innerHeight;
      const top = progressRef.current * Math.max(0, scroller.scrollHeight - height);
      // Native smooth scrolling would keep moving after the parent stops or reverses.
      if (container) container.scrollTo({ top, behavior: "instant" });
      else window.scrollTo({ top, behavior: "instant" });
      setIsAtBottom(progressRef.current === 1);
    };
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      const data = event.data;
      if (
        data?.type !== "rome:tour-scroll" ||
        typeof data.progress !== "number" ||
        !Number.isFinite(data.progress)
      )
        return;
      progressRef.current = Math.max(0, Math.min(1, data.progress));
      apply();
    };
    // Reapply the same position when async content or the opening side panel reflows the chat.
    const resize = new ResizeObserver(apply);
    resize.observe(content);
    const container = containerRef.current ?? findScrollableYAncestor(content);
    resize.observe(container ?? document.documentElement);
    window.addEventListener("message", receive);
    window.addEventListener("resize", apply);
    apply();
    window.parent.postMessage({ type: "rome:tour-scroll-ready" }, parentOrigin);
    return () => {
      resize.disconnect();
      window.removeEventListener("message", receive);
      window.removeEventListener("resize", apply);
    };
  }, [guided, content]);

  return guided
    ? { contentRef: setContent, scrollRef, isAtBottom, scrollToBottom: stayAtStart }
    : scroll;
}
