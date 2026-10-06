import { useEffect, useRef, useState } from "react";

/**
 * What a chat in this tab needs from the guardian, shown as a badge on the tab
 * favicon so a strip of Rome tabs reads at a glance.
 *
 * - `working`: the agent is replying.
 * - `needs-you`: the agent is parked on a card waiting for an answer.
 * - `failed`: the last turn ended with an error.
 * - `done`: a reply ended while the guardian was away from the tab; clears when
 *   they come back.
 */
export type TabStatus = "idle" | "working" | "failed" | "needs-you" | "done";

// When several chats share the tab (the main pane plus pinned side chats), the
// one that most needs the guardian wins.
const PRIORITY: Record<TabStatus, number> = {
  idle: 0,
  done: 1,
  working: 2,
  failed: 3,
  "needs-you": 4,
};

// Raw colors rather than theme tokens: the favicon sits in the browser's tab
// strip, outside every Rome theme.
const BADGE_COLORS: Record<Exclude<TabStatus, "idle">, string> = {
  working: "#2f6fdb",
  failed: "#d92d20",
  "needs-you": "#e08a00",
  done: "#1f9d55",
};

export function topTabStatus(statuses: Iterable<TabStatus>): TabStatus {
  let top: TabStatus = "idle";
  for (const status of statuses) if (PRIORITY[status] > PRIORITY[top]) top = status;
  return top;
}

export function deriveTabStatus(state: {
  streaming: boolean;
  awaitingGuardian: boolean;
  lastTurnFailed: boolean;
  finishedUnseen: boolean;
}): TabStatus {
  return topTabStatus([
    state.awaitingGuardian ? "needs-you" : "idle",
    state.lastTurnFailed ? "failed" : "idle",
    state.streaming ? "working" : "idle",
    state.finishedUnseen ? "done" : "idle",
  ]);
}

// One claim per mounted chat, rendered in priority order, so the result does not
// depend on which chat's effect ran last.
const claims = new Map<symbol, TabStatus>();

// Static badges only. Chrome shows just the first frame of an animated favicon,
// and background tabs throttle the timers a JS animation would need.
const BADGE_SIZE = 64;
let baseHref: string | null = null;
let baseType: string | null = null;
let shownBadge: string | null = null;
let logo: HTMLImageElement | null = null;
const badgeUrls = new Map<TabStatus, string>();

function iconLink(): HTMLLinkElement | null {
  return document.querySelector<HTMLLinkElement>('link[rel="icon"]');
}

// Glyph geometry in icon.svg's 52-unit grid, bottom-right corner: an open ring
// (the sidebar's spinner, held still), an exclamation mark, a cross, a check
// mark. Shape tells the states apart without color.
const GRID = 52;

function traceGlyph(
  ctx: CanvasRenderingContext2D,
  status: Exclude<TabStatus, "idle">,
  gap: boolean,
): void {
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.lineWidth = gap ? 11.5 : 5;
  if (status === "working") {
    if (gap) {
      ctx.beginPath();
      ctx.arc(43, 43, 10.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.lineWidth = 4;
    ctx.globalAlpha = 0.25;
    ctx.beginPath();
    ctx.arc(43, 43, 6.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(43, 43, 6.5, -Math.PI / 2, Math.PI);
    ctx.stroke();
  } else if (status === "needs-you") {
    ctx.beginPath();
    ctx.moveTo(45, 29);
    ctx.lineTo(45, 40);
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(45, 48, gap ? 6.2 : 2.9, 0, Math.PI * 2);
    ctx.fill();
  } else if (status === "failed") {
    ctx.beginPath();
    ctx.moveTo(34, 34);
    ctx.lineTo(48, 48);
    ctx.moveTo(48, 34);
    ctx.lineTo(34, 48);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.moveTo(30, 40);
    ctx.lineTo(37, 47);
    ctx.lineTo(49, 33);
    ctx.stroke();
  }
}

function badgeUrl(status: Exclude<TabStatus, "idle">, image: HTMLImageElement): string | null {
  const cached = badgeUrls.get(status);
  if (cached) return cached;
  const canvas = document.createElement("canvas");
  canvas.width = BADGE_SIZE;
  canvas.height = BADGE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // A logo served from another origin taints the canvas and toDataURL throws.
  // The badge is cosmetic, so the tab keeps the plain logo instead.
  try {
    drawBadge(ctx, status, image);
    const url = canvas.toDataURL("image/png");
    badgeUrls.set(status, url);
    return url;
  } catch {
    return null;
  }
}

function drawBadge(
  ctx: CanvasRenderingContext2D,
  status: Exclude<TabStatus, "idle">,
  image: HTMLImageElement,
): void {
  ctx.drawImage(image, 0, 0, BADGE_SIZE, BADGE_SIZE);
  ctx.scale(BADGE_SIZE / GRID, BADGE_SIZE / GRID);
  // Cut the logo away around the glyph instead of putting a disc behind it, so
  // the glyph reads on the black logo while covering as little of it as possible.
  ctx.globalCompositeOperation = "destination-out";
  traceGlyph(ctx, status, true);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = BADGE_COLORS[status];
  ctx.strokeStyle = BADGE_COLORS[status];
  traceGlyph(ctx, status, false);
}

function showLogo(link: HTMLLinkElement, href: string): void {
  link.setAttribute("href", href);
  if (baseType) link.setAttribute("type", baseType);
  else link.removeAttribute("type");
  shownBadge = null;
}

function render(): void {
  if (typeof document === "undefined") return;
  const link = iconLink();
  if (!link) return;
  // Whatever the link holds while no badge of ours is showing is the logo to
  // restore, type included.
  if (shownBadge === null || link.getAttribute("href") !== shownBadge) {
    baseHref = link.getAttribute("href");
    baseType = link.getAttribute("type");
    shownBadge = null;
  }
  if (!baseHref) return;
  const status = topTabStatus(claims.values());
  if (status === "idle") {
    showLogo(link, baseHref);
    return;
  }
  if (!logo) {
    logo = new Image();
    logo.addEventListener("load", render, { once: true });
    logo.src = baseHref;
  }
  if (!logo.complete || logo.naturalWidth === 0) return;
  const url = badgeUrl(status, logo);
  // Falls back to the logo rather than leaving another status's badge up.
  if (!url) {
    showLogo(link, baseHref);
    return;
  }
  // index.html declares the logo as SVG, and a browser may skip an icon whose
  // declared type does not match what it loads.
  link.setAttribute("type", "image/png");
  link.setAttribute("href", url);
  shownBadge = url;
}

/**
 * Shows `status` on the tab favicon for as long as the calling component is
 * mounted. Unmounting releases the claim, so leaving the chat restores the
 * plain logo.
 */
export function useTabStatus(status: TabStatus): void {
  const owner = useRef<symbol | null>(null);
  owner.current ??= Symbol("tab-status");

  useEffect(() => {
    const token = owner.current as symbol;
    claims.set(token, status);
    render();
    return () => {
      claims.delete(token);
      render();
    };
  }, [status]);
}

function isAway(): boolean {
  return document.hidden || !document.hasFocus();
}

/**
 * True once a reply ends while the guardian is away from the tab, until they
 * come back. `turnEnds` counts the turns the server has reported finished; the
 * caller bumps it on the stream's terminal event, never on a dropped
 * connection, which leaves the turn running. Local to this tab: the open chat
 * marks itself read on every message, so the server's unread flag never covers
 * it.
 */
export function useFinishedUnseen(turnEnds: number): boolean {
  const [finishedUnseen, setFinishedUnseen] = useState(false);
  const seenTurnEnds = useRef(turnEnds);

  useEffect(() => {
    if (turnEnds > seenTurnEnds.current && isAway()) setFinishedUnseen(true);
    seenTurnEnds.current = turnEnds;
  }, [turnEnds]);

  useEffect(() => {
    if (!finishedUnseen) return;
    const clearIfBack = () => {
      if (!isAway()) setFinishedUnseen(false);
    };
    document.addEventListener("visibilitychange", clearIfBack);
    window.addEventListener("focus", clearIfBack);
    // The guardian may have come back between the turn ending and these
    // listeners attaching, in which case no event is left to fire.
    clearIfBack();
    return () => {
      document.removeEventListener("visibilitychange", clearIfBack);
      window.removeEventListener("focus", clearIfBack);
    };
  }, [finishedUnseen]);

  return finishedUnseen;
}

/** Shows one chat's status on the tab favicon while the chat is mounted. */
export function useChatTabStatus(
  streaming: boolean,
  awaitingGuardian: boolean,
  lastTurnFailed: boolean,
  turnEnds: number,
): void {
  const finishedUnseen = useFinishedUnseen(turnEnds);
  useTabStatus(deriveTabStatus({ streaming, awaitingGuardian, lastTurnFailed, finishedUnseen }));
}
