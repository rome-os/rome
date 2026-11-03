// Reusable visitor sign-in UI. Access control: docs/architecture/access-control.md.

import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { BadgeCheck, CircleAlert, Cloud, Loader2, LogOut, ShieldCheck } from "lucide-react";
import {
  beginVisitorLogin,
  isPreview,
  useCaller,
  visitorLogout,
  type RomeAppCaller,
} from "./index.js";

/** Why `signIn()` / `signOut()` failed, mapped to author-friendly categories. */
export type VisitorSignInError = "unavailable" | "failed" | "signout_failed";

const ERROR_COPY: Record<VisitorSignInError, string> = {
  unavailable:
    "Rome Cloud sign-in isn't available on this instance yet — ask the owner to enable visitor sign-in for public apps.",
  failed: "Couldn't start Rome Cloud sign-in. Check your connection and try again.",
  signout_failed: "Couldn't sign out. Check your connection and try again.",
};

export interface VisitorSignInState {
  /** Host-resolved caller for this mount — advisory, UI gating only. */
  caller: RomeAppCaller | null;
  /**
   * True from the moment `signIn()` is invoked until the browser leaves for
   * the Rome Cloud authorization page (it stays true through the redirect so
   * the button never flashes back to idle). Reset only on failure.
   */
  signingIn: boolean;
  /**
   * True from the moment `signOut()` is invoked until the page reloads with
   * the visitor session cleared (it stays true through the reload so the UI
   * never flashes back to signed-in). Reset only on failure.
   */
  signingOut: boolean;
  /** Set when `signIn()` / `signOut()` failed; `null` otherwise. */
  error: VisitorSignInError | null;
  /** Human-readable message for {@link VisitorSignInState.error}. */
  errorMessage: string | null;
  /**
   * Begin the Rome Cloud sign-in redirect. `next` is the app-page location to
   * return to after authorizing (default: the current location). Never
   * throws: failures are committed to `error`/`errorMessage` and also
   * resolved as the return value (`null` = redirect underway).
   */
  signIn: (next?: string) => Promise<VisitorSignInError | null>;
  /**
   * End the visitor session and reload the page (the surface remounts with an
   * anonymous caller). Visitor-only — a guardian's dashboard session is never
   * touched. Never throws: failures are committed to `error`/`errorMessage`
   * and also resolved as the return value (`null` = reload underway).
   */
  signOut: () => Promise<VisitorSignInError | null>;
}

/**
 * Headless state machine for the visitor sign-in flow. Wraps
 * {@link beginVisitorLogin} with the pending/error bookkeeping every app was
 * re-implementing by hand:
 *
 * ```tsx
 * const { caller, signingIn, signIn, errorMessage } = useVisitorSignIn();
 * if (caller?.kind !== "visitor") {
 *   return <button onClick={() => void signIn()} disabled={signingIn}>Sign in</button>;
 * }
 * ```
 *
 * Prefer {@link CallerBadge} / {@link SignInWithRomeCloud} unless you need a
 * fully custom look.
 */
export function useVisitorSignIn(): VisitorSignInState {
  const caller = useCaller();
  const [signingIn, setSigningIn] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [error, setError] = useState<VisitorSignInError | null>(null);

  const signIn = useCallback(async (next?: string): Promise<VisitorSignInError | null> => {
    setSigningIn(true);
    setError(null);
    try {
      await beginVisitorLogin(next);
      // Success = a full-page redirect is underway. Deliberately keep
      // `signingIn` true so the UI stays in its "Redirecting…" state for the
      // last frames before the browser unloads this page.
      return null;
    } catch (err) {
      const kind: VisitorSignInError =
        err instanceof Error && err.message === "visitor_login_unavailable"
          ? "unavailable"
          : "failed";
      setError(kind);
      setSigningIn(false);
      return kind;
    }
  }, []);

  const signOut = useCallback(async (): Promise<VisitorSignInError | null> => {
    setSigningOut(true);
    setError(null);
    try {
      await visitorLogout();
      // Success = a full-page reload is underway; keep `signingOut` true for
      // the last frames before the browser unloads this page.
      return null;
    } catch {
      setError("signout_failed");
      setSigningOut(false);
      return "signout_failed";
    }
  }, []);

  return {
    caller,
    signingIn,
    signingOut,
    error,
    errorMessage: error ? ERROR_COPY[error] : null,
    signIn,
    signOut,
  };
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const BUTTON_BASE =
  "inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-md font-medium " +
  "shadow-1 transition-[background-color,box-shadow,transform] duration-150 outline-none " +
  "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background " +
  "active:scale-[0.98] disabled:pointer-events-none disabled:opacity-60 " +
  "[&_svg]:pointer-events-none [&_svg]:shrink-0";

const BUTTON_VARIANT: Record<"solid" | "outline", string> = {
  solid: "bg-primary text-primary-foreground hover:bg-primary-hover",
  outline: "border border-border bg-surface text-foreground hover:bg-surface-hover",
};

const BUTTON_SIZE: Record<"default" | "sm", string> = {
  default: "h-9 px-4 text-sm [&_svg]:size-4",
  sm: "h-8 gap-1.5 px-3 text-sm [&_svg]:size-3.5",
};

const PREVIEW_TITLE = "Sign-in is unavailable in store preview";

export interface SignInWithRomeCloudProps {
  /** `solid` (primary CTA, default) or `outline` (quiet placement). */
  variant?: "solid" | "outline";
  size?: "default" | "sm";
  /** App-page location to return to after authorizing (default: here). */
  next?: string;
  /**
   * Button label; default "Sign in". The Rome Cloud mark already names the
   * provider, so do not repeat it ("Sign in with Rome Cloud"). Override only
   * to name what signing in unlocks, e.g. "Sign in to save picks".
   */
  label?: string;
  className?: string;
  /** Called when the flow fails to start — convenience for toasts/telemetry.
   *  The button does not render the message itself; pair it with
   *  {@link CallerBadge} or your own alert for visible feedback. */
  onError?: (error: VisitorSignInError, message: string) => void;
}

/**
 * The standard Rome Cloud sign-in button — an OAuth-provider-style control
 * with the Rome Cloud mark, a built-in "Redirecting…" pending state, and
 * automatic degradation on preview mounts (disabled with an explanatory
 * tooltip, since a preview host has no backend to sign into). The label
 * defaults to "Sign in", which is all a visitor needs to read.
 *
 * Renders nothing when the caller is already signed in (visitor) or is the
 * instance owner (guardian), so it can be dropped in unconditionally. For the
 * full identity control (avatar icon + error alert) use {@link CallerBadge}.
 */
export function SignInWithRomeCloud({
  variant = "solid",
  size = "default",
  next,
  label = "Sign in",
  className,
  onError,
}: SignInWithRomeCloudProps): ReactElement | null {
  const { caller, signingIn, signIn } = useVisitorSignIn();
  const preview = isPreview();

  if (caller && caller.kind !== "anonymous") return null;

  return (
    <button
      type="button"
      className={cx(BUTTON_BASE, BUTTON_VARIANT[variant], BUTTON_SIZE[size], className)}
      disabled={signingIn || preview}
      title={preview ? PREVIEW_TITLE : undefined}
      aria-busy={signingIn}
      onClick={() => {
        void signIn(next).then((err) => {
          if (err) onError?.(err, ERROR_COPY[err]);
        });
      }}
    >
      {signingIn ? <Loader2 className="animate-spin" aria-hidden /> : <Cloud aria-hidden />}
      {signingIn ? "Redirecting…" : label}
    </button>
  );
}

export interface CallerBadgeProps {
  className?: string;
  /**
   * Tooltip on the sign-in button for anonymous callers.
   * Default: "Sign in with Rome Cloud to continue."
   */
  signedOutHint?: string;
  /**
   * Tooltip on the owner icon (the owner never signs in as a visitor).
   * Default: "You're the instance owner." Pass `null` to hide the guardian
   * badge entirely.
   */
  guardianHint?: string | null;
  /** App-page location to return to after authorizing (default: here). */
  next?: string;
}

/**
 * The compact "who am I" control for a visitor-facing app header, sized to
 * sit in the top-right corner:
 *
 * - **visitor** → the signed-in user's avatar icon (email initial) with a
 *   verified check; clicking it opens a small account menu with the full
 *   email and a **Sign out** item (visitor-only — it never touches a
 *   guardian's dashboard session).
 * - **guardian** → the owner shield, tinted with the theme accent
 *   (suppressible). Passive: the owner's session belongs to the dashboard,
 *   so there is no sign-out here.
 * - **anonymous** → a small "Sign in" button, plus an alert underneath when
 *   the sign-in flow cannot start on this instance.
 *
 * Drop it at the end of the header row and it handles every state:
 *
 * ```tsx
 * <header className="flex items-center">
 *   <h1>My app</h1>
 *   <CallerBadge className="ml-auto" />
 * </header>
 * ```
 */
export function CallerBadge({
  className,
  signedOutHint = "Sign in with Rome Cloud to continue.",
  guardianHint = "You're the instance owner.",
  next,
}: CallerBadgeProps): ReactElement | null {
  const { caller, signingIn, signIn, signingOut, signOut, error, errorMessage } =
    useVisitorSignIn();
  const preview = isPreview();

  if (caller?.kind === "visitor") {
    return (
      <VisitorAccountMenu
        caller={caller}
        className={className}
        signingOut={signingOut}
        signOut={signOut}
        errorMessage={error === "signout_failed" ? errorMessage : null}
      />
    );
  }

  if (caller?.kind === "guardian") {
    if (guardianHint === null) return null;
    return (
      <span className={cx("inline-flex shrink-0", className)} title={guardianHint}>
        <span className="grid size-8 place-items-center rounded-full border border-border bg-surface-muted text-primary shadow-1">
          <ShieldCheck className="size-4" aria-hidden />
        </span>
        <span className="sr-only">{guardianHint}</span>
      </span>
    );
  }

  // Anonymous — or a host too old to deliver the caller, where offering
  // sign-in is the safe default (the server still enforces on request.caller).
  return (
    <div className={cx("flex flex-col items-end gap-2", className)}>
      <button
        type="button"
        className={cx(BUTTON_BASE, BUTTON_VARIANT.outline, BUTTON_SIZE.sm)}
        disabled={signingIn || preview}
        title={preview ? PREVIEW_TITLE : signedOutHint}
        aria-busy={signingIn}
        onClick={() => void signIn(next)}
      >
        {signingIn ? <Loader2 className="animate-spin" aria-hidden /> : <Cloud aria-hidden />}
        {signingIn ? "Redirecting…" : "Sign in"}
      </button>
      {error ? (
        <div
          role="alert"
          className="flex max-w-64 items-start gap-2 rounded-md border border-warning-border bg-warning-bg p-3 text-xs text-warning-fg"
        >
          <CircleAlert className="mt-px size-3.5 shrink-0" aria-hidden />
          <span>{errorMessage}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Signed-in visitor avatar that toggles a small anchored account menu (email +
 * Sign out). Hand-rolled rather than a popover library: the SDK ships no
 * floating-UI dependency, and the menu must stay inside the app's Shadow DOM
 * to keep its styles — which is also why outside-click detection reads
 * `composedPath()` (a document-level listener only sees the shadow host as
 * `event.target`).
 */
function VisitorAccountMenu({
  caller,
  className,
  signingOut,
  signOut,
  errorMessage,
}: {
  caller: Extract<RomeAppCaller, { kind: "visitor" }>;
  className?: string;
  signingOut: boolean;
  signOut: () => Promise<VisitorSignInError | null>;
  errorMessage: string | null;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const container = containerRef.current;
      if (container && !event.composedPath().includes(container)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const initial = caller.email.trim().charAt(0).toUpperCase() || "?";

  return (
    <div ref={containerRef} className={cx("relative inline-flex shrink-0", className)}>
      <button
        type="button"
        className="relative inline-flex rounded-full outline-none transition-transform duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:scale-[0.98]"
        title={caller.email}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span
          aria-hidden
          className="grid size-8 place-items-center rounded-full bg-primary text-xs font-semibold text-primary-foreground shadow-1"
        >
          {initial}
        </span>
        <BadgeCheck
          className="absolute -right-1 -bottom-1 size-4 rounded-full bg-surface p-px text-success-fg"
          aria-hidden
        />
        <span className="sr-only">Signed in as {caller.email} — open account menu</span>
      </button>
      {open ? (
        <div
          role="menu"
          className="absolute top-full right-0 z-50 mt-2 w-56 rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-4"
        >
          <div className="px-2 py-1.5">
            <div className="text-xs text-muted-foreground">Signed in as</div>
            <div className="truncate text-sm font-medium" title={caller.email}>
              {caller.email}
            </div>
          </div>
          <div aria-hidden className="my-1 h-px bg-border" />
          <button
            type="button"
            role="menuitem"
            className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-surface-hover focus-visible:bg-surface-hover disabled:pointer-events-none disabled:opacity-60"
            disabled={signingOut}
            aria-busy={signingOut}
            onClick={() => void signOut()}
          >
            {signingOut ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : (
              <LogOut className="size-4" aria-hidden />
            )}
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
          {errorMessage ? (
            <div role="alert" className="px-2 py-1.5 text-xs text-warning-fg">
              {errorMessage}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
