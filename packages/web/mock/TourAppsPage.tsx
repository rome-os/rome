import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import AppsIndexPage from "../src/pages/AppsIndexPage.js";
import "./tour-apps.css";

const CASES = [
  { name: "YouTube Distill", tile: "/apps/yt-distill", path: "/apps/yt-distill/llm-deep-dive" },
  { name: "Code Review", tile: "/apps/code-review", path: "/apps/code-review" },
  { name: "Issue Triage", tile: "/apps/issue-triage", path: "/apps/issue-triage" },
  { name: "Fitness Tracker", tile: "/apps/fitness-tracker", path: "/apps/fitness-tracker" },
  { name: "Stock Daily", tile: "/apps/stock-daily", path: "/apps/stock-daily" },
];
type Spotlight = (typeof CASES)[number] & { x: number; y: number; width: number; height: number };

// Only the mock build substitutes this wrapper for the real Apps page.
export default function TourAppsPage() {
  const navigate = useNavigate();
  const [active, setActive] = useState(false);
  const [spots, setSpots] = useState<Spotlight[]>([]);
  const pageRef = useRef<HTMLDivElement>(null);
  const guideRef = useRef<HTMLDivElement>(null);
  const maskId = useId();
  const titleId = useId();
  const parentOrigin = document.referrer ? new URL(document.referrer).origin : null;

  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("tour") !== "apps" || !parentOrigin) return;
    const receive = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== parentOrigin) return;
      if (event.data?.type === "rome:tour-apps" && typeof event.data.active === "boolean") {
        setActive(event.data.active);
      }
    };
    window.addEventListener("message", receive);
    window.parent.postMessage({ type: "rome:tour-apps-ready" }, parentOrigin);
    return () => window.removeEventListener("message", receive);
  }, [parentOrigin]);

  useEffect(() => {
    if (!active) return;
    const page = pageRef.current;
    if (!page) return;
    let frame = 0;
    const highlighted = new Set<HTMLElement>();
    const measure = () => {
      const next = CASES.flatMap((app) => {
        const tile = page.querySelector<HTMLAnchorElement>(`a[href="${app.tile}"]`)?.parentElement;
        if (!tile) return [];
        tile.dataset.tourHighlight = "true";
        highlighted.add(tile);
        const rect = tile.getBoundingClientRect();
        return [
          { ...app, x: rect.x - 4, y: rect.y - 4, width: rect.width + 8, height: rect.height + 8 },
        ];
      });
      setSpots((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    const resize = new ResizeObserver(schedule);
    resize.observe(page);
    const mutation = new MutationObserver(schedule);
    mutation.observe(page, { childList: true, subtree: true });
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);
    schedule();
    guideRef.current?.focus({ preventScroll: true });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
      for (const tile of highlighted) delete tile.dataset.tourHighlight;
    };
  }, [active]);

  function finish(app: Spotlight | null) {
    setActive(false);
    if (parentOrigin)
      window.parent.postMessage(
        { type: "rome:tour-apps-exit", app: app?.name ?? null },
        parentOrigin,
      );
    if (app) navigate(app.path);
  }

  const group = spots.length
    ? {
        x: Math.min(...spots.map((spot) => spot.x)) - 8,
        y: Math.min(...spots.map((spot) => spot.y)) - 8,
        right: Math.max(...spots.map((spot) => spot.x + spot.width)) + 8,
        bottom: Math.max(...spots.map((spot) => spot.y + spot.height)) + 8,
      }
    : null;
  const top = group?.y ?? 300;
  return (
    <>
      <div ref={pageRef} style={{ display: "contents" }} inert={active}>
        <AppsIndexPage />
      </div>
      {active &&
        createPortal(
          <div
            ref={guideRef}
            className="tour-apps-guide"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") finish(null);
              if (event.key !== "Tab") return;
              const buttons = guideRef.current?.querySelectorAll<HTMLButtonElement>("button");
              if (!buttons?.length) return;
              const first = buttons[0];
              const last = buttons[buttons.length - 1];
              if (
                event.shiftKey &&
                (document.activeElement === first || document.activeElement === guideRef.current)
              ) {
                event.preventDefault();
                last.focus();
              } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
              }
            }}
          >
            <svg className="tour-apps-mask" width="100%" height="100%" aria-hidden="true">
              <defs>
                <mask id={maskId} maskUnits="userSpaceOnUse" x="0" y="0" width="100%" height="100%">
                  <rect width="100%" height="100%" fill="white" />
                  {group && (
                    <rect
                      x={group.x}
                      y={group.y}
                      width={group.right - group.x}
                      height={group.bottom - group.y}
                      rx="18"
                      fill="black"
                    />
                  )}
                </mask>
              </defs>
              <rect
                width="100%"
                height="100%"
                fill="rgba(35, 34, 33, 0.64)"
                mask={`url(#${maskId})`}
              />
            </svg>
            {group && (
              <div
                className="tour-apps-group"
                style={{
                  left: group.x,
                  top: group.y,
                  width: group.right - group.x,
                  height: group.bottom - group.y,
                }}
              />
            )}
            <div className="tour-apps-copy" style={{ top: Math.max(24, top - 210) }}>
              <h2 id={titleId}>Rome App is the new way to interact with your agent.</h2>
              <p>Pick an app. See what your agent can do.</p>
              <button type="button" onClick={() => finish(null)}>
                Explore on my own <span aria-hidden="true">↗</span>
              </button>
            </div>
            {spots.map((spot) => (
              <button
                key={spot.tile}
                type="button"
                className="tour-apps-target"
                aria-label={`Explore ${spot.name}`}
                style={{
                  left: spot.x,
                  top: spot.y,
                  width: spot.width,
                  height: spot.height,
                }}
                onClick={() => finish(spot)}
              />
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
